use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomaticWorkflow {
    pub id: String,
    pub project_id: String,
    pub mode: String,
    pub resolution: String,
    pub status: String,
    pub stage: String,
    pub progress: f64,
    pub message: String,
    pub retry_message: Option<String>,
    pub snapshot: Value,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

pub fn create(
    connection: &Connection,
    project_id: &str,
    mode: &str,
    resolution: &str,
) -> Result<AutomaticWorkflow, String> {
    let id = format!("WF_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO automatic_workflows(
                id, project_id, mode, resolution, status, stage, progress,
                message, snapshot_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'RUNNING', 'assets', 0,
                '正在初始化自动制作工作流', ?5, ?6, ?6)",
            params![
                id,
                project_id,
                mode,
                resolution,
                json!({"items": []}).to_string(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get(connection, &id)?.ok_or_else(|| "创建自动制作工作流后未能读取记录".to_owned())
}

pub fn get(connection: &Connection, id: &str) -> Result<Option<AutomaticWorkflow>, String> {
    connection
        .query_row(
            "SELECT id, project_id, mode, resolution, status, stage, progress,
                    message, retry_message, snapshot_json, created_at, updated_at, finished_at
             FROM automatic_workflows WHERE id = ?1",
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn get_active(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<AutomaticWorkflow>, String> {
    connection
        .query_row(
            "SELECT id, project_id, mode, resolution, status, stage, progress,
                    message, retry_message, snapshot_json, created_at, updated_at, finished_at
             FROM automatic_workflows
             WHERE project_id = ?1 AND status IN ('PENDING', 'RUNNING')
             ORDER BY updated_at DESC LIMIT 1",
            [project_id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn update(
    connection: &Connection,
    id: &str,
    project_id: &str,
    status: &str,
    stage: &str,
    progress: f64,
    message: &str,
    retry_message: Option<&str>,
    snapshot: &Value,
) -> Result<AutomaticWorkflow, String> {
    let now = Utc::now().to_rfc3339();
    let finished_at = matches!(status, "COMPLETED" | "CANCELLED").then_some(now.as_str());
    let changed = connection
        .execute(
            "UPDATE automatic_workflows SET status = ?1, stage = ?2, progress = ?3,
                    message = ?4, retry_message = ?5, snapshot_json = ?6,
                    updated_at = ?7, finished_at = ?8
             WHERE id = ?9 AND project_id = ?10",
            params![
                status,
                stage,
                progress.clamp(0.0, 1.0),
                message,
                retry_message,
                snapshot.to_string(),
                now,
                finished_at,
                id,
                project_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("未找到要更新的自动制作工作流".to_owned());
    }
    get(connection, id)?.ok_or_else(|| "更新自动制作工作流后未能读取记录".to_owned())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomaticWorkflow> {
    let snapshot_json: String = row.get(9)?;
    Ok(AutomaticWorkflow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        mode: row.get(2)?,
        resolution: row.get(3)?,
        status: row.get(4)?,
        stage: row.get(5)?,
        progress: row.get(6)?,
        message: row.get(7)?,
        retry_message: row.get(8)?,
        snapshot: serde_json::from_str(&snapshot_json).unwrap_or_else(|_| json!({"items": []})),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        finished_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
             VALUES ('P1', 'test', 'C:/test', 'SCRIPT', 'ACTIVE', 'now', 'now')",
            [],
        ).unwrap();
        connection
    }

    #[test]
    fn persists_and_completes_automatic_workflow_snapshot() {
        let connection = connection();
        let workflow = create(&connection, "P1", "storyboard", "1080p").unwrap();
        let snapshot = json!({"items": [{"target_id": "SCENE_001", "status": "RUNNING"}]});
        let running = update(
            &connection,
            &workflow.id,
            "P1",
            "RUNNING",
            "assets",
            0.25,
            "生成场景图",
            None,
            &snapshot,
        )
        .unwrap();
        assert_eq!(running.snapshot, snapshot);
        assert_eq!(
            get_active(&connection, "P1").unwrap().unwrap().id,
            workflow.id
        );
        update(
            &connection,
            &workflow.id,
            "P1",
            "COMPLETED",
            "completed",
            1.0,
            "完成",
            None,
            &snapshot,
        )
        .unwrap();
        assert!(get_active(&connection, "P1").unwrap().is_none());
    }

    #[test]
    fn cancelled_workflow_is_no_longer_active() {
        let connection = connection();
        let workflow = create(&connection, "P1", "fast", "720p").unwrap();
        let snapshot = json!({"items": []});
        let cancelled = update(
            &connection,
            &workflow.id,
            "P1",
            "CANCELLED",
            "assets",
            0.2,
            "工作流已停止",
            None,
            &snapshot,
        )
        .unwrap();
        assert_eq!(cancelled.status, "CANCELLED");
        assert!(cancelled.finished_at.is_some());
        assert!(get_active(&connection, "P1").unwrap().is_none());
    }
}
