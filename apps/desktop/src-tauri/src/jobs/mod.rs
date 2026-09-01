pub mod state;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;

pub fn create(
    connection: &Connection,
    project_id: &str,
    job_type: &str,
    payload: &Value,
) -> Result<String, String> {
    let id = format!("JOB_{}", uuid::Uuid::new_v4().simple());
    connection.execute(
        "INSERT INTO jobs(id, project_id, job_type, status, progress, payload_json, created_at) VALUES (?1, ?2, ?3, 'PENDING', 0, ?4, ?5)",
        params![id, project_id, job_type, payload.to_string(), Utc::now().to_rfc3339()],
    ).map_err(|error| error.to_string())?;
    Ok(id)
}

pub fn update(
    connection: &Connection,
    job_id: &str,
    status: &str,
    progress: f64,
    stage: Option<&str>,
    message: Option<&str>,
) -> Result<(), String> {
    let current: String = connection
        .query_row("SELECT status FROM jobs WHERE id = ?1", [job_id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if current != status && !state::can_transition(&current, status) {
        return Err(format!("invalid job transition: {current} -> {status}"));
    }
    let now = Utc::now().to_rfc3339();
    let started_at = if status == "RUNNING" {
        Some(now.as_str())
    } else {
        None
    };
    let finished_at = if matches!(status, "COMPLETED" | "FAILED" | "CANCELLED") {
        Some(now.as_str())
    } else {
        None
    };
    connection.execute(
        "UPDATE jobs SET status=?1, progress=?2, stage=?3, started_at=COALESCE(started_at, ?4), finished_at=COALESCE(?5, finished_at) WHERE id=?6",
        params![status, progress, stage, started_at, finished_at, job_id],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO job_events(job_id, status, progress, stage, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![job_id, status, progress, stage, message, now],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn fail(connection: &Connection, job_id: &str, error: &Value) -> Result<(), String> {
    update(
        connection,
        job_id,
        "FAILED",
        0.0,
        Some("failed"),
        error.get("message").and_then(Value::as_str),
    )?;
    connection
        .execute(
            "UPDATE jobs SET error_json=?1 WHERE id=?2",
            params![error.to_string(), job_id],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}
