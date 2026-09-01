use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const STATUS_PENDING: &str = "PENDING";
pub const STATUS_RUNNING: &str = "RUNNING";
pub const STATUS_REMOTE_PROCESSING: &str = "REMOTE_PROCESSING";
pub const STATUS_DOWNLOADING: &str = "DOWNLOADING";
pub const STATUS_COMPLETED: &str = "COMPLETED";
pub const STATUS_FAILED: &str = "FAILED";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenerationTask {
    pub id: String,
    pub project_id: String,
    pub target_type: String,
    pub target_id: String,
    pub base_url: String,
    pub model: String,
    pub protocol: String,
    pub prompt: String,
    pub aspect_ratio: String,
    pub status: String,
    pub progress: f64,
    pub remote_task_id: Option<String>,
    pub result_relative_path: Option<String>,
    pub result_absolute_path: Option<String>,
    pub result_mime_type: Option<String>,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub retry_count: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

pub struct NewImageGenerationTask<'a> {
    pub project_id: &'a str,
    pub target_type: &'a str,
    pub target_id: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
    pub protocol: &'a str,
    pub prompt: &'a str,
    pub aspect_ratio: &'a str,
}

pub fn create(
    connection: &Connection,
    input: NewImageGenerationTask<'_>,
) -> Result<ImageGenerationTask, String> {
    let id = format!("IMG_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO image_generation_tasks(
                id, project_id, target_type, target_id, base_url, model, protocol,
                prompt, aspect_ratio, status, progress, retry_count, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, ?11, ?11)",
            params![
                id,
                input.project_id,
                input.target_type,
                input.target_id,
                input.base_url,
                input.model,
                input.protocol,
                input.prompt,
                input.aspect_ratio,
                STATUS_PENDING,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    get(connection, &id)?.ok_or_else(|| "创建生图任务后未能读取任务".to_owned())
}

pub fn get(connection: &Connection, id: &str) -> Result<Option<ImageGenerationTask>, String> {
    connection
        .query_row(
            "SELECT id, project_id, target_type, target_id, base_url, model, protocol,
                    prompt, aspect_ratio, status, progress, remote_task_id,
                    result_relative_path, result_absolute_path, result_mime_type,
                    result_json, error_json, retry_count, created_at, started_at,
                    updated_at, finished_at
             FROM image_generation_tasks WHERE id = ?1",
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ImageGenerationTask>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, target_type, target_id, base_url, model, protocol,
                    prompt, aspect_ratio, status, progress, remote_task_id,
                    result_relative_path, result_absolute_path, result_mime_type,
                    result_json, error_json, retry_count, created_at, started_at,
                    updated_at, finished_at
             FROM image_generation_tasks WHERE project_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], read_row)
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

pub fn list_unfinished(connection: &Connection) -> Result<Vec<ImageGenerationTask>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, target_type, target_id, base_url, model, protocol,
                    prompt, aspect_ratio, status, progress, remote_task_id,
                    result_relative_path, result_absolute_path, result_mime_type,
                    result_json, error_json, retry_count, created_at, started_at,
                    updated_at, finished_at
             FROM image_generation_tasks
             WHERE status NOT IN ('COMPLETED', 'FAILED')
             ORDER BY created_at",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read_row)
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

pub fn has_unfinished_target(
    connection: &Connection,
    project_id: &str,
    target_type: &str,
    target_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM image_generation_tasks
                WHERE project_id = ?1 AND target_type = ?2 AND target_id = ?3
                  AND status NOT IN ('COMPLETED', 'FAILED')
            )",
            params![project_id, target_type, target_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub fn mark_running(connection: &Connection, id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE image_generation_tasks
             SET status = ?1, progress = 0.1, started_at = COALESCE(started_at, ?2),
                 updated_at = ?2, retry_count = retry_count + 1, error_json = NULL
             WHERE id = ?3",
            params![STATUS_RUNNING, now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn mark_remote_processing(
    connection: &Connection,
    id: &str,
    remote_task_id: &str,
) -> Result<(), String> {
    update_state(
        connection,
        id,
        STATUS_REMOTE_PROCESSING,
        0.35,
        Some(remote_task_id),
    )
}

pub fn mark_downloading(connection: &Connection, id: &str) -> Result<(), String> {
    update_state(connection, id, STATUS_DOWNLOADING, 0.8, None)
}

fn update_state(
    connection: &Connection,
    id: &str,
    status: &str,
    progress: f64,
    remote_task_id: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE image_generation_tasks
             SET status = ?1, progress = ?2,
                 remote_task_id = COALESCE(?3, remote_task_id), updated_at = ?4
             WHERE id = ?5",
            params![status, progress, remote_task_id, now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn complete(
    connection: &mut Connection,
    id: &str,
    relative_path: &str,
    absolute_path: &str,
    mime_type: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let task =
        get_in_transaction(&transaction, id)?.ok_or_else(|| format!("找不到生图任务：{id}"))?;
    if task.status == STATUS_COMPLETED { return Ok(()); }
    let now = Utc::now().to_rfc3339();
    let result = json!({
        "relative_path": relative_path,
        "absolute_path": absolute_path,
        "mime_type": mime_type,
    });
    transaction
        .execute(
            "UPDATE image_generation_tasks
             SET status = ?1, progress = 1, result_relative_path = ?2,
                 result_absolute_path = ?3, result_mime_type = ?4, result_json = ?5,
                 error_json = NULL, updated_at = ?6, finished_at = ?6
             WHERE id = ?7",
            params![
                STATUS_COMPLETED,
                relative_path,
                absolute_path,
                mime_type,
                result.to_string(),
                now,
                id,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO assets(id, project_id, asset_type, owner_type, owner_id,
                                relative_path, status, data_json, created_at)
             VALUES (?1, ?2, 'GENERATED_IMAGE', ?3, ?4, ?5, 'READY', ?6, ?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                task.project_id,
                task.target_type,
                task.target_id,
                relative_path,
                json!({"task_id": id, "mime_type": mime_type}).to_string(),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    attach_reference_asset(
        &transaction,
        &task.target_type,
        &task.target_id,
        relative_path,
        &now,
    )?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn fail(connection: &Connection, id: &str, message: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let error_value =
        serde_json::from_str::<Value>(message).unwrap_or_else(|_| json!({"message": message}));
    connection
        .execute(
            "UPDATE image_generation_tasks
             SET status = ?1, error_json = ?2, updated_at = ?3, finished_at = ?3
             WHERE id = ?4 AND status <> 'COMPLETED'",
            params![STATUS_FAILED, error_value.to_string(), now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn attach_reference_asset(
    transaction: &Transaction<'_>,
    target_type: &str,
    target_id: &str,
    relative_path: &str,
    now: &str,
) -> Result<(), String> {
    let table = match target_type {
        "character" => "characters",
        "character_state" => "character_states",
        "scene" => "scenes",
        "shot" => "shots",
        _ => return Err(format!("不支持的生图目标类型：{target_type}")),
    };
    let raw: Option<String> = transaction
        .query_row(
            &format!("SELECT data_json FROM {table} WHERE id = ?1"),
            [target_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let mut value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("{table}.data_json 不是对象"))?;
    let assets = object
        .entry("reference_assets")
        .or_insert_with(|| Value::Array(Vec::new()));
    let array = assets
        .as_array_mut()
        .ok_or_else(|| "reference_assets 不是数组".to_owned())?;
    array.retain(|value| value.as_str() != Some(relative_path));
    array.insert(0, Value::String(relative_path.to_owned()));
    transaction
        .execute(
            &format!("UPDATE {table} SET data_json = ?1, updated_at = ?2 WHERE id = ?3"),
            params![value.to_string(), now, target_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_in_transaction(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<Option<ImageGenerationTask>, String> {
    transaction
        .query_row(
            "SELECT id, project_id, target_type, target_id, base_url, model, protocol,
                    prompt, aspect_ratio, status, progress, remote_task_id,
                    result_relative_path, result_absolute_path, result_mime_type,
                    result_json, error_json, retry_count, created_at, started_at,
                    updated_at, finished_at
             FROM image_generation_tasks WHERE id = ?1",
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageGenerationTask> {
    let result_raw: Option<String> = row.get(15)?;
    let error_raw: Option<String> = row.get(16)?;
    Ok(ImageGenerationTask {
        id: row.get(0)?,
        project_id: row.get(1)?,
        target_type: row.get(2)?,
        target_id: row.get(3)?,
        base_url: row.get(4)?,
        model: row.get(5)?,
        protocol: row.get(6)?,
        prompt: row.get(7)?,
        aspect_ratio: row.get(8)?,
        status: row.get(9)?,
        progress: row.get(10)?,
        remote_task_id: row.get(11)?,
        result_relative_path: row.get(12)?,
        result_absolute_path: row.get(13)?,
        result_mime_type: row.get(14)?,
        result: result_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        error: error_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        retry_count: row.get(17)?,
        created_at: row.get(18)?,
        started_at: row.get(19)?,
        updated_at: row.get(20)?,
        finished_at: row.get(21)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
                 VALUES ('P_TEST', '测试项目', 'C:/test', 'IDEA', 'ACTIVE', 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO characters(id, project_id, name, role, data_json, locked, created_at, updated_at)
                 VALUES ('CHAR_001', 'P_TEST', '测试角色', 'PROTAGONIST', ?1, 0, 'now', 'now')",
                [json!({"id": "CHAR_001", "name": "测试角色", "reference_assets": []}).to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO character_states(id, project_id, character_id, state_order, name, data_json, locked, created_at, updated_at)
                 VALUES ('CHAR_001_STATE_001', 'P_TEST', 'CHAR_001', 0, '默认状态', ?1, 0, 'now', 'now')",
                [json!({"id":"CHAR_001_STATE_001","name":"默认状态","reference_assets":[]}).to_string()],
            )
            .unwrap();
        connection
    }

    #[test]
    fn persists_task_result_asset_and_owner_reference() {
        let mut connection = database();
        let task = create(
            &connection,
            NewImageGenerationTask {
                project_id: "P_TEST",
                target_type: "character",
                target_id: "CHAR_001",
                base_url: "https://example.com",
                model: "image-model",
                protocol: "openai",
                prompt: "这是一段足够长度的测试生图提示词",
                aspect_ratio: "9:16",
            },
        )
        .unwrap();
        mark_running(&connection, &task.id).unwrap();
        complete(
            &mut connection,
            &task.id,
            "characters/CHAR_001.png",
            "C:/test/characters/CHAR_001.png",
            "image/png",
        )
        .unwrap();

        let completed = get(&connection, &task.id).unwrap().unwrap();
        assert_eq!(completed.status, STATUS_COMPLETED);
        assert_eq!(
            completed.result_relative_path.as_deref(),
            Some("characters/CHAR_001.png")
        );
        let asset_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(asset_count, 1);
        let owner: String = connection
            .query_row(
                "SELECT data_json FROM characters WHERE id = 'CHAR_001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let owner: Value = serde_json::from_str(&owner).unwrap();
        assert_eq!(
            owner.pointer("/reference_assets/0").and_then(Value::as_str),
            Some("characters/CHAR_001.png")
        );
    }

    #[test]
    fn unfinished_tasks_include_remote_task_for_resume() {
        let connection = database();
        let task = create(
            &connection,
            NewImageGenerationTask {
                project_id: "P_TEST",
                target_type: "character",
                target_id: "CHAR_001",
                base_url: "https://example.com",
                model: "media-model",
                protocol: "media",
                prompt: "这是一段足够长度的异步生图提示词",
                aspect_ratio: "16:9",
            },
        )
        .unwrap();
        mark_remote_processing(&connection, &task.id, "REMOTE_123").unwrap();

        let unfinished = list_unfinished(&connection).unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].remote_task_id.as_deref(), Some("REMOTE_123"));
        assert_eq!(unfinished[0].status, STATUS_REMOTE_PROCESSING);
    }

    #[test]
    fn attaches_generated_image_to_a_character_state() {
        let mut connection = database();
        let task = create(
            &connection,
            NewImageGenerationTask {
                project_id: "P_TEST",
                target_type: "character_state",
                target_id: "CHAR_001_STATE_001",
                base_url: "https://example.com",
                model: "image-model",
                protocol: "openai",
                prompt: "生成测试角色处于默认状态的完整角色参考图",
                aspect_ratio: "9:16",
            },
        )
        .unwrap();
        complete(
            &mut connection,
            &task.id,
            "characters/states/default.png",
            "C:/test/characters/states/default.png",
            "image/png",
        )
        .unwrap();
        let raw: String = connection
            .query_row(
                "SELECT data_json FROM character_states WHERE id='CHAR_001_STATE_001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let state: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            state.pointer("/reference_assets/0").and_then(Value::as_str),
            Some("characters/states/default.png")
        );
    }
}
