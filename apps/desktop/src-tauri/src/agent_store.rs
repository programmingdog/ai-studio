use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub project_path: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub stage: String,
    pub progress: f64,
    pub model: String,
    pub input: Value,
    pub state: Value,
    pub error: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::platform_session::user_scoped_sqlite(app, "agent.db")
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT,
                project_path TEXT,
                status TEXT NOT NULL DEFAULT 'ACTIVE',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES agent_sessions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_messages_session
                ON agent_messages(session_id, created_at);
            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                model TEXT NOT NULL,
                input_json TEXT NOT NULL DEFAULT '{}',
                state_json TEXT NOT NULL DEFAULT '{}',
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(session_id) REFERENCES agent_sessions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_runs_session
                ON agent_runs(session_id, created_at);
            CREATE TABLE IF NOT EXISTS agent_tool_calls (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                status TEXT NOT NULL,
                arguments_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT,
                error_json TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(run_id) REFERENCES agent_runs(id)
            );",
        )
        .map_err(|error| error.to_string())?;
    crate::platform_session::bind_user_owned_tables(
        &connection,
        &[
            "agent_sessions",
            "agent_messages",
            "agent_runs",
            "agent_tool_calls",
        ],
    )?;
    Ok(connection)
}

pub fn ensure_session(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    title: &str,
) -> Result<AgentSession, String> {
    let connection = open(app)?;
    if let Some(id) = session_id {
        if let Some(session) = get_session(&connection, id)? {
            return Ok(session);
        }
    }
    let id = format!("CHAT_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let title = title.trim().chars().take(40).collect::<String>();
    let title = if title.is_empty() {
        "新的制作对话"
    } else {
        &title
    };
    connection
        .execute(
            "INSERT INTO agent_sessions(id, title, status, created_at, updated_at)
             VALUES (?1, ?2, 'ACTIVE', ?3, ?3)",
            params![id, title, now],
        )
        .map_err(|error| error.to_string())?;
    get_session(&connection, &id)?.ok_or_else(|| "创建 Agent 会话后无法读取".to_owned())
}

pub fn list_sessions(app: &tauri::AppHandle) -> Result<Vec<AgentSession>, String> {
    let connection = open(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, project_id, project_path, status, created_at, updated_at
             FROM agent_sessions ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read_session)
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    rows
}

fn get_session(connection: &Connection, id: &str) -> Result<Option<AgentSession>, String> {
    connection
        .query_row(
            "SELECT id, title, project_id, project_path, status, created_at, updated_at
             FROM agent_sessions WHERE id = ?1",
            [id],
            read_session,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSession> {
    Ok(AgentSession {
        id: row.get(0)?,
        title: row.get(1)?,
        project_id: row.get(2)?,
        project_path: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn append_message(
    app: &tauri::AppHandle,
    session_id: &str,
    role: &str,
    content: &str,
    metadata: &Value,
) -> Result<AgentMessage, String> {
    let connection = open(app)?;
    let id = format!("MSG_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO agent_messages(id, session_id, role, content, metadata_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, role, content, metadata.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE agent_sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(AgentMessage {
        id,
        session_id: session_id.to_owned(),
        role: role.to_owned(),
        content: content.to_owned(),
        metadata: metadata.clone(),
        created_at: now,
    })
}

pub fn list_messages(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<AgentMessage>, String> {
    let connection = open(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, role, content, metadata_json, created_at
             FROM agent_messages WHERE session_id = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], |row| {
            let metadata: String = row.get(4)?;
            Ok(AgentMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                metadata: serde_json::from_str(&metadata)
                    .unwrap_or(Value::Object(Default::default())),
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    rows
}

pub fn create_run(
    app: &tauri::AppHandle,
    session_id: &str,
    model: &str,
    input: &Value,
) -> Result<AgentRun, String> {
    let connection = open(app)?;
    let id = format!("RUN_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO agent_runs(id, session_id, status, stage, progress, model,
             input_json, state_json, created_at, updated_at)
             VALUES (?1, ?2, 'RUNNING', 'planning', 0.05, ?3, ?4, '{}', ?5, ?5)",
            params![id, session_id, model, input.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    get_run(&connection, &id)?.ok_or_else(|| "创建 Agent 运行记录后无法读取".to_owned())
}

pub fn update_run(
    app: &tauri::AppHandle,
    id: &str,
    status: &str,
    stage: &str,
    progress: f64,
    state: &Value,
    error: Option<&Value>,
) -> Result<AgentRun, String> {
    let connection = open(app)?;
    let now = Utc::now().to_rfc3339();
    let finished = matches!(status, "COMPLETED" | "FAILED").then_some(now.clone());
    connection
        .execute(
            "UPDATE agent_runs SET status = ?1, stage = ?2, progress = ?3,
             state_json = ?4, error_json = ?5, updated_at = ?6,
             finished_at = COALESCE(?7, finished_at) WHERE id = ?8",
            params![
                status,
                stage,
                progress.clamp(0.0, 1.0),
                state.to_string(),
                error.map(Value::to_string),
                now,
                finished,
                id
            ],
        )
        .map_err(|error| error.to_string())?;
    get_run(&connection, id)?.ok_or_else(|| "更新 Agent 运行记录后无法读取".to_owned())
}

pub fn list_runs(app: &tauri::AppHandle, session_id: &str) -> Result<Vec<AgentRun>, String> {
    let connection = open(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, status, stage, progress, model, input_json, state_json,
             error_json, created_at, updated_at, finished_at FROM agent_runs
             WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 50",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], read_run)
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    rows
}

fn get_run(connection: &Connection, id: &str) -> Result<Option<AgentRun>, String> {
    connection
        .query_row(
            "SELECT id, session_id, status, stage, progress, model, input_json, state_json,
             error_json, created_at, updated_at, finished_at FROM agent_runs WHERE id = ?1",
            [id],
            read_run,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRun> {
    let input: String = row.get(6)?;
    let state: String = row.get(7)?;
    let error: Option<String> = row.get(8)?;
    Ok(AgentRun {
        id: row.get(0)?,
        session_id: row.get(1)?,
        status: row.get(2)?,
        stage: row.get(3)?,
        progress: row.get(4)?,
        model: row.get(5)?,
        input: serde_json::from_str(&input).unwrap_or(Value::Null),
        state: serde_json::from_str(&state).unwrap_or(Value::Null),
        error: error.and_then(|value| serde_json::from_str(&value).ok()),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        finished_at: row.get(11)?,
    })
}

pub fn start_tool_call(
    app: &tauri::AppHandle,
    run_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<String, String> {
    let connection = open(app)?;
    let id = format!("CALL_{}", uuid::Uuid::new_v4().simple());
    connection
        .execute(
            "INSERT INTO agent_tool_calls(id, run_id, tool_name, status, arguments_json, created_at)
             VALUES (?1, ?2, ?3, 'RUNNING', ?4, ?5)",
            params![id, run_id, tool_name, arguments.to_string(), Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(id)
}

pub fn finish_tool_call(
    app: &tauri::AppHandle,
    id: &str,
    result: Result<&Value, &Value>,
) -> Result<(), String> {
    let connection = open(app)?;
    let (status, result_json, error_json) = match result {
        Ok(value) => ("COMPLETED", Some(value.to_string()), None),
        Err(value) => ("FAILED", None, Some(value.to_string())),
    };
    connection
        .execute(
            "UPDATE agent_tool_calls SET status = ?1, result_json = ?2, error_json = ?3,
             finished_at = ?4 WHERE id = ?5",
            params![status, result_json, error_json, Utc::now().to_rfc3339(), id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn attach_project(
    app: &tauri::AppHandle,
    session_id: &str,
    project_id: &str,
    project_path: &str,
) -> Result<(), String> {
    let connection = open(app)?;
    connection
        .execute(
            "UPDATE agent_sessions SET project_id = ?1, project_path = ?2, updated_at = ?3
             WHERE id = ?4",
            params![
                project_id,
                project_path,
                Utc::now().to_rfc3339(),
                session_id
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_types_serialize_metadata() {
        let message = AgentMessage {
            id: "MSG_1".into(),
            session_id: "CHAT_1".into(),
            role: "assistant".into(),
            content: "ok".into(),
            metadata: serde_json::json!({"action": "open_project"}),
            created_at: "now".into(),
        };
        assert_eq!(
            serde_json::to_value(message).unwrap()["metadata"]["action"],
            "open_project"
        );
    }
}
