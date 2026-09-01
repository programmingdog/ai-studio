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
pub struct GenerationRecord {
    pub id: String,
    pub project_id: String,
    pub media_type: String,
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

pub struct NewGenerationRecord<'a> {
    pub project_id: &'a str,
    pub media_type: &'a str,
    pub target_type: &'a str,
    pub target_id: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
    pub protocol: &'a str,
    pub prompt: &'a str,
    pub aspect_ratio: &'a str,
}

const COLUMNS: &str = "id, project_id, media_type, target_type, target_id, base_url, model,
 protocol, prompt, aspect_ratio, status, progress, remote_task_id, result_relative_path,
 result_absolute_path, result_mime_type, result_json, error_json, retry_count, created_at,
 started_at, updated_at, finished_at";

pub fn create(
    connection: &Connection,
    input: NewGenerationRecord<'_>,
) -> Result<GenerationRecord, String> {
    let id = format!("GEN_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO generation_records(id, project_id, media_type, target_type, target_id,
         base_url, model, protocol, prompt, aspect_ratio, status, progress, retry_count,
         created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
         ?11, 0, 0, ?12, ?12)",
            params![
                id,
                input.project_id,
                input.media_type,
                input.target_type,
                input.target_id,
                input.base_url,
                input.model,
                input.protocol,
                input.prompt,
                input.aspect_ratio,
                STATUS_PENDING,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get(connection, &id)?.ok_or_else(|| "创建生成流水后未能读取记录".to_owned())
}

pub fn get(connection: &Connection, id: &str) -> Result<Option<GenerationRecord>, String> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM generation_records WHERE id = ?1"),
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<GenerationRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
        "SELECT {COLUMNS} FROM generation_records WHERE project_id = ?1 ORDER BY created_at DESC"
    ))
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([project_id], read_row)
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    records
}

pub fn list_unfinished_videos(connection: &Connection) -> Result<Vec<GenerationRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM generation_records WHERE media_type = 'video'
         AND status NOT IN ('COMPLETED', 'FAILED') ORDER BY created_at"
        ))
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], read_row)
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    records
}

pub fn has_unfinished_video(
    connection: &Connection,
    project_id: &str,
    shot_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM generation_records WHERE project_id = ?1
         AND media_type = 'video' AND target_type = 'shot' AND target_id = ?2
         AND status NOT IN ('COMPLETED', 'FAILED'))",
            params![project_id, shot_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub fn mark_running(connection: &Connection, id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE generation_records SET status = ?1, progress = .1,
         started_at = COALESCE(started_at, ?2), updated_at = ?2,
         retry_count = retry_count + 1, error_json = NULL WHERE id = ?3",
            params![STATUS_RUNNING, now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn set_request_metadata(
    connection: &Connection,
    id: &str,
    value: &Value,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE generation_records SET result_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![value.to_string(), now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn mark_remote_processing(
    connection: &Connection,
    id: &str,
    remote_id: &str,
) -> Result<(), String> {
    update_state(
        connection,
        id,
        STATUS_REMOTE_PROCESSING,
        0.35,
        Some(remote_id),
    )
}

pub fn mark_downloading(connection: &Connection, id: &str) -> Result<(), String> {
    update_state(connection, id, STATUS_DOWNLOADING, 0.8, None)
}

pub fn update_progress(connection: &Connection, id: &str, progress: f64) -> Result<(), String> {
    update_state(
        connection,
        id,
        STATUS_RUNNING,
        progress.clamp(0.1, 0.95),
        None,
    )
}

fn update_state(
    connection: &Connection,
    id: &str,
    status: &str,
    progress: f64,
    remote_id: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE generation_records SET status = ?1, progress = ?2,
         remote_task_id = COALESCE(?3, remote_task_id), updated_at = ?4 WHERE id = ?5",
            params![status, progress, remote_id, now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn complete_video(
    connection: &mut Connection,
    id: &str,
    relative_path: &str,
    absolute_path: &str,
    mime_type: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let record =
        get_in_transaction(&transaction, id)?.ok_or_else(|| format!("找不到视频生成流水：{id}"))?;
    let now = Utc::now().to_rfc3339();
    let result = json!({"relative_path": relative_path, "absolute_path": absolute_path, "mime_type": mime_type});
    transaction
        .execute(
            "UPDATE generation_records SET status = ?1, progress = 1, result_relative_path = ?2,
         result_absolute_path = ?3, result_mime_type = ?4, result_json = ?5,
         error_json = NULL, updated_at = ?6, finished_at = ?6 WHERE id = ?7",
            params![
                STATUS_COMPLETED,
                relative_path,
                absolute_path,
                mime_type,
                result.to_string(),
                now,
                id
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO assets(id, project_id, asset_type, owner_type, owner_id, relative_path,
         status, data_json, created_at) VALUES (?1, ?2, 'GENERATED_VIDEO', 'shot', ?3, ?4,
         'READY', ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                record.project_id,
                record.target_id,
                relative_path,
                json!({"generation_id": id, "mime_type": mime_type}).to_string(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    attach_shot_video(&transaction, &record.target_id, relative_path, &now)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn complete_project_video(
    connection: &mut Connection,
    id: &str,
    relative_path: &str,
    absolute_path: &str,
    mime_type: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let record = get_in_transaction(&transaction, id)?
        .ok_or_else(|| format!("找不到项目视频合成流水：{id}"))?;
    let now = Utc::now().to_rfc3339();
    let result = json!({"relative_path": relative_path, "absolute_path": absolute_path, "mime_type": mime_type});
    transaction
        .execute(
            "UPDATE generation_records SET status = ?1, progress = 1, result_relative_path = ?2,
         result_absolute_path = ?3, result_mime_type = ?4, result_json = ?5,
         error_json = NULL, updated_at = ?6, finished_at = ?6 WHERE id = ?7",
            params![
                STATUS_COMPLETED,
                relative_path,
                absolute_path,
                mime_type,
                result.to_string(),
                now,
                id
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO assets(id, project_id, asset_type, owner_type, owner_id, relative_path,
         status, data_json, created_at) VALUES (?1, ?2, 'COMPOSED_VIDEO', 'project', ?3, ?4,
         'READY', ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                record.project_id,
                record.target_id,
                relative_path,
                json!({"generation_id": id, "mime_type": mime_type}).to_string(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn fail(connection: &Connection, id: &str, message: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let error_value =
        serde_json::from_str::<Value>(message).unwrap_or_else(|_| json!({"message": message}));
    connection
        .execute(
            "UPDATE generation_records SET status = ?1, error_json = ?2,
         updated_at = ?3, finished_at = ?3 WHERE id = ?4",
            params![STATUS_FAILED, error_value.to_string(), now, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn attach_shot_video(
    transaction: &Transaction<'_>,
    shot_id: &str,
    relative_path: &str,
    now: &str,
) -> Result<(), String> {
    let raw: Option<String> = transaction
        .query_row(
            "SELECT data_json FROM shots WHERE id = ?1",
            [shot_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let mut value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let assets = value
        .as_object_mut()
        .ok_or("shots.data_json 不是对象")?
        .entry("video_assets")
        .or_insert_with(|| Value::Array(Vec::new()));
    let array = assets.as_array_mut().ok_or("video_assets 不是数组")?;
    array.retain(|item| item.as_str() != Some(relative_path));
    array.insert(0, Value::String(relative_path.to_owned()));
    transaction
        .execute(
            "UPDATE shots SET data_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![value.to_string(), now, shot_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_in_transaction(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<Option<GenerationRecord>, String> {
    transaction
        .query_row(
            &format!("SELECT {COLUMNS} FROM generation_records WHERE id = ?1"),
            [id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationRecord> {
    let result_raw: Option<String> = row.get(16)?;
    let error_raw: Option<String> = row.get(17)?;
    Ok(GenerationRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        media_type: row.get(2)?,
        target_type: row.get(3)?,
        target_id: row.get(4)?,
        base_url: row.get(5)?,
        model: row.get(6)?,
        protocol: row.get(7)?,
        prompt: row.get(8)?,
        aspect_ratio: row.get(9)?,
        status: row.get(10)?,
        progress: row.get(11)?,
        remote_task_id: row.get(12)?,
        result_relative_path: row.get(13)?,
        result_absolute_path: row.get(14)?,
        result_mime_type: row.get(15)?,
        result: result_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        error: error_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        retry_count: row.get(18)?,
        created_at: row.get(19)?,
        started_at: row.get(20)?,
        updated_at: row.get(21)?,
        finished_at: row.get(22)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
             VALUES ('P_TEST', '测试', 'C:/test', 'SCRIPT', 'ACTIVE', 'now', 'now')", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO shots(id, project_id, shot_order, duration, data_json, status, locked, created_at, updated_at)
             VALUES ('A-001', 'P_TEST', 0, 10, ?1, 'DRAFT', 0, 'now', 'now')",
            [json!({"id": "A-001", "video_assets": []}).to_string()],
        ).unwrap();
        connection
    }

    #[test]
    fn persists_video_result_and_attaches_it_to_shot() {
        let mut connection = database();
        let record = create(
            &connection,
            NewGenerationRecord {
                project_id: "P_TEST",
                media_type: "video",
                target_type: "shot",
                target_id: "A-001",
                base_url: "https://example.com",
                model: "video-model",
                protocol: "media",
                prompt: "测试视频提示词",
                aspect_ratio: "9:16",
            },
        )
        .unwrap();
        set_request_metadata(&connection, &record.id, &json!({"duration": 10})).unwrap();
        complete_video(
            &mut connection,
            &record.id,
            "shots/videos/A-001.mp4",
            "C:/test/A-001.mp4",
            "video/mp4",
        )
        .unwrap();

        let completed = get(&connection, &record.id).unwrap().unwrap();
        assert_eq!(completed.status, STATUS_COMPLETED);
        let shot: String = connection
            .query_row(
                "SELECT data_json FROM shots WHERE id = 'A-001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let shot: Value = serde_json::from_str(&shot).unwrap();
        assert_eq!(
            shot.pointer("/video_assets/0").and_then(Value::as_str),
            Some("shots/videos/A-001.mp4")
        );
        let asset_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE asset_type = 'GENERATED_VIDEO'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(asset_count, 1);
    }

    #[test]
    fn persists_composed_project_video_without_attaching_it_to_a_shot() {
        let mut connection = database();
        let record = create(
            &connection,
            NewGenerationRecord {
                project_id: "P_TEST",
                media_type: "video",
                target_type: "project",
                target_id: "P_TEST",
                base_url: "local://ffmpeg",
                model: "FFmpeg",
                protocol: "local-compose",
                prompt: "按分镜顺序合成",
                aspect_ratio: "16:9",
            },
        )
        .unwrap();
        complete_project_video(
            &mut connection,
            &record.id,
            "assets/generated/project/final.mp4",
            "C:/test/final.mp4",
            "video/mp4",
        )
        .unwrap();

        let completed = get(&connection, &record.id).unwrap().unwrap();
        assert_eq!(completed.status, STATUS_COMPLETED);
        assert_eq!(completed.target_type, "project");
        assert_eq!(
            completed.result_relative_path.as_deref(),
            Some("assets/generated/project/final.mp4")
        );
        let project_asset_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE asset_type = 'COMPOSED_VIDEO' AND owner_type = 'project'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_asset_count, 1);
        let shot: String = connection
            .query_row(
                "SELECT data_json FROM shots WHERE id = 'A-001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let shot: Value = serde_json::from_str(&shot).unwrap();
        assert_eq!(shot.pointer("/video_assets/0"), None);
    }

    #[test]
    fn image_task_trigger_creates_unified_generation_record() {
        let connection = database();
        connection.execute(
            "INSERT INTO image_generation_tasks(id, project_id, target_type, target_id, base_url,
             model, protocol, prompt, aspect_ratio, status, progress, retry_count, created_at, updated_at)
             VALUES ('IMG_TEST', 'P_TEST', 'shot', 'A-001', 'https://example.com', 'image-model',
             'openai', '测试图片提示词', '9:16', 'PENDING', 0, 0, 'now', 'now')", [],
        ).unwrap();
        let synced = get(&connection, "IMG_TEST").unwrap().unwrap();
        assert_eq!(synced.media_type, "image");
        assert_eq!(synced.target_type, "shot");
        set_request_metadata(
            &connection,
            "IMG_TEST",
            &json!({"reference_assets": [{"relative_path": "scenes/a.png"}]}),
        )
        .unwrap();
        connection.execute("UPDATE image_generation_tasks SET status = 'RUNNING', progress = .1 WHERE id = 'IMG_TEST'", []).unwrap();
        let running = get(&connection, "IMG_TEST").unwrap().unwrap();
        assert_eq!(
            running
                .result
                .as_ref()
                .and_then(|value| value.pointer("/reference_assets/0/relative_path"))
                .and_then(Value::as_str),
            Some("scenes/a.png")
        );
    }
}
