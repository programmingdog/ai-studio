use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeaDevelopmentWorkflow {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub stage: String,
    pub progress: f64,
    pub message: String,
    pub target_duration: f64,
    pub chunk_duration: f64,
    pub snapshot: Value,
    pub error: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

pub fn create(
    connection: &Connection,
    project_id: &str,
    target_duration: f64,
    chunk_duration: f64,
) -> Result<IdeaDevelopmentWorkflow, String> {
    let id = format!("IDEAWF_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO idea_development_workflows(
            id, project_id, status, stage, progress, message, target_duration,
            chunk_duration, snapshot_json, created_at, updated_at
         ) VALUES (?1, ?2, 'RUNNING', 'outline_review', 0.02,
            '正在根据Idea生成整体大纲', ?3, ?4, ?5, ?6, ?6)",
            params![
                id,
                project_id,
                target_duration,
                chunk_duration,
                json!({}).to_string(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get(connection, &id)?.ok_or_else(|| "创建创意分步工作流失败".to_owned())
}

pub fn latest(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<IdeaDevelopmentWorkflow>, String> {
    connection
        .query_row(
            "SELECT id, project_id, status, stage, progress, message, target_duration,
                chunk_duration, snapshot_json, error_json, created_at, updated_at, finished_at
         FROM idea_development_workflows WHERE project_id = ?1
         ORDER BY updated_at DESC LIMIT 1",
            [project_id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn get(connection: &Connection, id: &str) -> Result<Option<IdeaDevelopmentWorkflow>, String> {
    connection
        .query_row(
            "SELECT id, project_id, status, stage, progress, message, target_duration,
                chunk_duration, snapshot_json, error_json, created_at, updated_at, finished_at
         FROM idea_development_workflows WHERE id = ?1",
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn update(
    connection: &Connection,
    id: &str,
    status: &str,
    stage: &str,
    progress: f64,
    message: &str,
    snapshot: &Value,
    error: Option<&Value>,
) -> Result<IdeaDevelopmentWorkflow, String> {
    let now = Utc::now().to_rfc3339();
    let finished_at =
        matches!(status, "COMPLETED" | "FAILED" | "CANCELLED").then_some(now.as_str());
    connection
        .execute(
            "UPDATE idea_development_workflows SET status=?1, stage=?2, progress=?3,
            message=?4, snapshot_json=?5, error_json=?6, updated_at=?7, finished_at=?8
         WHERE id=?9",
            params![
                status,
                stage,
                progress.clamp(0.0, 1.0),
                message,
                snapshot.to_string(),
                error.map(Value::to_string),
                now,
                finished_at,
                id
            ],
        )
        .map_err(|error| error.to_string())?;
    get(connection, id)?.ok_or_else(|| "更新长篇创作工作流失败".to_owned())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IdeaDevelopmentWorkflow> {
    let snapshot: String = row.get(8)?;
    let error: Option<String> = row.get(9)?;
    Ok(IdeaDevelopmentWorkflow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        status: row.get(2)?,
        stage: row.get(3)?,
        progress: row.get(4)?,
        message: row.get(5)?,
        target_duration: row.get(6)?,
        chunk_duration: row.get(7)?,
        snapshot: serde_json::from_str(&snapshot).unwrap_or_else(|_| json!({})),
        error: error.and_then(|value| serde_json::from_str(&value).ok()),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        finished_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_resumable_guided_idea_snapshot() {
        let connection = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection.execute("INSERT INTO projects(id,name,project_path,input_type,status,created_at,updated_at) VALUES('P1','长篇','C:/p','IDEA','DRAFT','now','now')", []).unwrap();
        let workflow = create(&connection, "P1", 3600.0, 90.0).unwrap();
        let snapshot = json!({"completed_segments": [{"id": "SEG_001"}]});
        update(
            &connection,
            &workflow.id,
            "RUNNING",
            "segments",
            0.4,
            "已完成1段",
            &snapshot,
            None,
        )
        .unwrap();
        let loaded = latest(&connection, "P1").unwrap().unwrap();
        assert_eq!(loaded.snapshot, snapshot);
        assert_eq!(loaded.chunk_duration, 90.0);
    }
}
