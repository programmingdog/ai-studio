use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
use tauri::Manager;


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDouyinUnderstandingTaskInput {
    share_text: String,
    prompt: String,
    source_width: Option<u64>,
    source_height: Option<u64>,
    aspect_ratio: Option<String>,
    #[serde(default)]
    managed: bool,
    browser_cookie_source: Option<String>,
    cookie_file_path: Option<String>,
    video_info: Value,
    mode: String,
    fixed_seconds: Option<u64>,
    #[serde(default)]
    platform_api_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveLocalVideoUnderstandingTaskInput {
    video_path: String,
    mode: String,
    fixed_seconds: Option<u64>,
    duration: Option<f64>,
    aspect_ratio: Option<String>,
    result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLocalVideoUnderstandingTaskInput {
    video_path: String,
    prompt: String,
    mode: String,
    fixed_seconds: Option<u64>,
    #[serde(default)]
    platform_api_base_url: Option<String>,
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::platform_session::user_scoped_sqlite(app, "douyin-understanding.db")
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
            "CREATE TABLE IF NOT EXISTS douyin_understanding_tasks (
                id TEXT PRIMARY KEY,
                share_text TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                uploader TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT 'UNKNOWN',
                thumbnail TEXT,
                duration REAL,
                width INTEGER,
                height INTEGER,
                aspect_ratio TEXT,
                mode TEXT NOT NULL,
                fixed_seconds INTEGER,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                input_json TEXT NOT NULL,
                result_json TEXT,
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                source_kind TEXT NOT NULL DEFAULT 'LINK'
            );
            CREATE INDEX IF NOT EXISTS idx_douyin_understanding_tasks_created
                ON douyin_understanding_tasks(created_at DESC);",
        )
        .map_err(|error| error.to_string())?;
    crate::platform_session::bind_user_owned_tables(&connection, &["douyin_understanding_tasks"])?;
    let has_platform = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('douyin_understanding_tasks') WHERE name = 'platform'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        > 0;
    if !has_platform {
        connection
            .execute(
                "ALTER TABLE douyin_understanding_tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'UNKNOWN'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    let has_source_kind = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('douyin_understanding_tasks') WHERE name = 'source_kind'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        > 0;
    if !has_source_kind {
        connection
            .execute(
                "ALTER TABLE douyin_understanding_tasks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'LINK'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(connection)
}

fn value_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let result_json: Option<String> = row.get(16)?;
    let error_json: Option<String> = row.get(17)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "share_text": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
        "uploader": row.get::<_, String>(3)?,
        "platform": row.get::<_, String>(4)?,
        "thumbnail": row.get::<_, Option<String>>(5)?,
        "duration": row.get::<_, Option<f64>>(6)?,
        "width": row.get::<_, Option<u64>>(7)?,
        "height": row.get::<_, Option<u64>>(8)?,
        "aspect_ratio": row.get::<_, Option<String>>(9)?,
        "mode": row.get::<_, String>(10)?,
        "fixed_seconds": row.get::<_, Option<u64>>(11)?,
        "status": row.get::<_, String>(12)?,
        "stage": row.get::<_, String>(13)?,
        "progress": row.get::<_, f64>(14)?,
        "message": row.get::<_, String>(15)?,
        "result": result_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "error": error_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "created_at": row.get::<_, String>(18)?,
        "updated_at": row.get::<_, String>(19)?,
        "finished_at": row.get::<_, Option<String>>(20)?,
        "source_kind": row.get::<_, String>(21)?,
    }))
}

const SELECT_TASK: &str =
    "SELECT id, share_text, title, uploader, platform, thumbnail, duration, width, height,
    aspect_ratio, mode, fixed_seconds, status, stage, progress, message, result_json, error_json,
    created_at, updated_at, finished_at, source_kind FROM douyin_understanding_tasks";

fn get_task(app: &tauri::AppHandle, task_id: &str) -> Result<Value, String> {
    let connection = open(app)?;
    connection
        .query_row(
            &format!("{SELECT_TASK} WHERE id = ?1"),
            [task_id],
            task_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "视频理解任务不存在".to_owned())
}

fn update_progress(
    app: &tauri::AppHandle,
    task_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
) {
    if let Ok(connection) = open(app) {
        let _ = connection.execute(
            "UPDATE douyin_understanding_tasks SET status = 'RUNNING', stage = ?2, progress = ?3,
             message = ?4, updated_at = ?5 WHERE id = ?1",
            params![task_id, stage, progress, message, Utc::now().to_rfc3339()],
        );
    }
}

fn link_analysis_prompt(input: &CreateDouyinUnderstandingTaskInput) -> Result<String, String> {
    let aspect_ratio = match input.aspect_ratio.as_deref() {
        Some("9:16") => Some("9:16"),
        Some("16:9") => Some("16:9"),
        Some(_) => return Err("视频画面比例必须是 9:16 或 16:9".to_owned()),
        None => match (input.source_width, input.source_height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                Some(if width > height { "16:9" } else { "9:16" })
            }
            _ => None,
        },
    };
    Ok(if let Some(aspect_ratio) = aspect_ratio {
        let resolution = match (input.source_width, input.source_height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => format!("{width}×{height}"),
            _ => "未提供".to_owned(),
        };
        format!(
            "{}\n\n【原视频权威元数据】\n原视频分辨率：{}\n原视频画面比例：{}\n以上比例已由下载器读取的视频宽高确定。项目剧情与每一个分镜的“屏幕比例”都必须严格输出为 {}，不得根据画面内容重新猜测或改写。",
            input.prompt.trim(), resolution, aspect_ratio, aspect_ratio
        )
    } else {
        input.prompt.trim().to_owned()
    })
}

fn spawn_task(app: tauri::AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let input_json = open(&app).and_then(|connection| {
            connection
                .query_row(
                    "SELECT input_json FROM douyin_understanding_tasks WHERE id = ?1",
                    [&task_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())
        });
        let input = match input_json.and_then(|value| {
            serde_json::from_str::<CreateDouyinUnderstandingTaskInput>(&value)
                .map_err(|error| error.to_string())
        }) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let video_url = value_text(&input.video_info, "download_url");
        if video_url.is_empty() {
            finish_failed(&app, &task_id, "解析结果中缺少可访问的视频 URL".to_owned());
            return;
        }
        let ext = value_text(&input.video_info, "ext").to_ascii_lowercase();
        let mime_type = match ext.as_str() {
            "webm" => "video/webm",
            "mov" => "video/mov",
            "mpeg" | "mpg" => "video/mpeg",
            "avi" => "video/avi",
            "flv" => "video/x-flv",
            "wmv" => "video/wmv",
            "3gp" | "3gpp" => "video/3gpp",
            _ => "video/mp4",
        };
        let prompt = match link_analysis_prompt(&input) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let title = value_text(&input.video_info, "title");
        let video_name = format!("{}.{}", if title.is_empty() { "video" } else { &title }, if ext.is_empty() { "mp4" } else { &ext });
        update_progress(&app, &task_id, "submitting", 0.28, "正在将解析后的视频公网地址提交到服务端");
        update_progress(&app, &task_id, "analyzing", 0.55, "服务端 AI 正在理解视频并生成分镜脚本");
        match crate::platform_video_understanding::understand_public_url(
            input.platform_api_base_url.as_deref(),
            &video_url,
            mime_type,
            &prompt,
            video_name,
        )
        .await
        {
            Ok(result) => {
                if let (Ok(connection), Ok(result_json)) =
                    (open(&app), serde_json::to_string(&result))
                {
                    let now = Utc::now().to_rfc3339();
                    let _ = connection.execute(
                        "UPDATE douyin_understanding_tasks SET status = 'COMPLETED', stage = 'completed',
                         progress = 1, message = '视频理解与分镜生成完成', result_json = ?2,
                         error_json = NULL, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
                        params![task_id, result_json, now],
                    );
                }
            }
            Err(error) => finish_failed(&app, &task_id, error),
        }
    });
}

fn spawn_local_task(app: tauri::AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let input_json = open(&app).and_then(|connection| {
            connection
                .query_row(
                    "SELECT input_json FROM douyin_understanding_tasks WHERE id = ?1 AND source_kind = 'LOCAL'",
                    [&task_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())
        });
        let input = match input_json.and_then(|value| {
            serde_json::from_str::<CreateLocalVideoUnderstandingTaskInput>(&value)
                .map_err(|error| error.to_string())
        }) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, format!("本地视频任务参数损坏：{error}"));
                return;
            }
        };
        let source_path = PathBuf::from(&input.video_path);
        let metadata = match tokio::fs::metadata(&source_path).await {
            Ok(value) if value.is_file() && value.len() > 0 => value,
            _ => {
                finish_failed(&app, &task_id, "本地视频文件不存在或已经被移动".to_owned());
                return;
            }
        };
        let original_name = source_path.file_name().and_then(|value| value.to_str()).unwrap_or("video").to_owned();
        let temp_dir = match app.path().app_cache_dir() {
            Ok(path) => path.join("video-understanding-upload"),
            Err(error) => {
                finish_failed(&app, &task_id, format!("无法定位视频缓存目录：{error}"));
                return;
            }
        };
        if let Err(error) = tokio::fs::create_dir_all(&temp_dir).await {
            finish_failed(&app, &task_id, format!("无法创建视频缓存目录：{error}"));
            return;
        }
        let compressed_path = temp_dir.join(format!("{}-compressed.mp4", uuid::Uuid::new_v4().simple()));
        update_progress(&app, &task_id, "compressing", 0.18, "正在压缩本地视频，准备上传服务端");
        let compression_source = source_path.clone();
        let compression_target = compressed_path.clone();
        let compression = tauri::async_runtime::spawn_blocking(move || {
            crate::media_tools::compress_video_for_inline_analysis(
                &compression_source,
                &compression_target,
                crate::ai::LINGKE_INLINE_TARGET,
            )
        })
        .await;
        match compression {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = tokio::fs::remove_file(&compressed_path).await;
                finish_failed(&app, &task_id, error);
                return;
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&compressed_path).await;
                finish_failed(&app, &task_id, format!("视频压缩任务异常：{error}"));
                return;
            }
        }
        update_progress(
            &app,
            &task_id,
            "analyzing",
            0.48,
            "正在上传压缩视频，服务端 AI 随后会理解视频并生成分镜脚本",
        );
        let analysis = crate::platform_video_understanding::understand_uploaded_file(
            input.platform_api_base_url.as_deref(),
            &compressed_path,
            &input.prompt,
            original_name,
            metadata.len(),
        )
        .await;
        let _ = tokio::fs::remove_file(&compressed_path).await;
        match analysis {
            Ok(result) => {
                if let (Ok(connection), Ok(result_json)) =
                    (open(&app), serde_json::to_string(&result))
                {
                    let now = Utc::now().to_rfc3339();
                    let _ = connection.execute(
                        "UPDATE douyin_understanding_tasks SET status = 'COMPLETED', stage = 'completed',
                         progress = 1, message = '视频理解与分镜生成完成', result_json = ?2,
                         error_json = NULL, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
                        params![task_id, result_json, now],
                    );
                }
            }
            Err(error) => finish_failed(&app, &task_id, error),
        }
    });
}

fn finish_failed(app: &tauri::AppHandle, task_id: &str, error: String) {
    let parsed = serde_json::from_str::<Value>(&error)
        .unwrap_or_else(|_| json!({"message": error, "retryable": true}));
    if let (Ok(connection), Ok(error_json)) = (open(app), serde_json::to_string(&parsed)) {
        let now = Utc::now().to_rfc3339();
        let _ = connection.execute(
            "UPDATE douyin_understanding_tasks SET status = 'FAILED', stage = 'failed',
             message = '任务执行失败', error_json = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
            params![task_id, error_json, now],
        );
    }
}

#[tauri::command]
pub fn create_douyin_understanding_task(
    app: tauri::AppHandle,
    input: CreateDouyinUnderstandingTaskInput,
) -> Result<Value, String> {
    if input.share_text.trim().is_empty() || input.prompt.trim().len() < 10 {
        return Err("视频链接或视频理解提示词无效".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    let connection = open(&app)?;
    let id = format!("DYTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    let title = value_text(&input.video_info, "title");
    let uploader = value_text(&input.video_info, "uploader");
    let platform = match value_text(&input.video_info, "platform") {
        value if value.is_empty() => "UNKNOWN".to_owned(),
        value => value,
    };
    let thumbnail = input.video_info.get("thumbnail").and_then(Value::as_str);
    let duration = input.video_info.get("duration").and_then(Value::as_f64);
    let width = input.video_info.get("width").and_then(Value::as_u64);
    let height = input.video_info.get("height").and_then(Value::as_u64);
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, thumbnail, duration, width, height, aspect_ratio,
                mode, fixed_seconds, status, stage, progress, message, input_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'PENDING', 'queued', 0,
                '已加入队列，等待后台执行', ?13, ?14, ?14)",
            params![id, input.share_text, title, uploader, platform, thumbnail, duration, width, height,
                input.aspect_ratio, input.mode, input.fixed_seconds, input_json, now],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    spawn_task(app.clone(), id.clone());
    get_task(&app, &id)
}

#[tauri::command]
pub async fn list_douyin_understanding_tasks(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    crate::background::run("读取视频理解任务", move || {
        let connection = open(&app)?;
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_TASK} WHERE source_kind = 'LINK' ORDER BY created_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let tasks = statement
            .query_map([], task_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub async fn list_local_video_understanding_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<Value>, String> {
    crate::background::run("读取本地视频理解任务", move || {
        let connection = open(&app)?;
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_TASK} WHERE source_kind = 'LOCAL' ORDER BY created_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let tasks = statement
            .query_map([], task_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub fn create_local_video_understanding_task(
    app: tauri::AppHandle,
    mut input: CreateLocalVideoUnderstandingTaskInput,
) -> Result<Value, String> {
    let video_path = PathBuf::from(input.video_path.trim());
    if !video_path.is_file() {
        return Err("请选择有效的本地视频文件".to_owned());
    }
    if input.prompt.trim().len() < 10 {
        return Err("视频理解提示词无效".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    let metadata = crate::media_tools::probe_video_metadata(&video_path)?;
    input.prompt = format!(
        "{}\n\n【本地视频真实时长（最高优先级）】\nFFprobe 已确认本视频完整时长为 {:.3} 秒，画面尺寸为 {}×{}。必须从 0 秒开始分析并连续覆盖到 {:.3} 秒的真实结尾；最后一个分镜的结束时间必须等于 {:.3} 秒（仅允许 0.5 秒以内的取整误差）。不得在 40 秒或任何中间位置提前结束，不得遗漏后半段内容，也不得虚构超出视频结尾的内容。输出前必须核对分镜时间轴总时长。",
        input.prompt.trim(),
        metadata.duration,
        metadata.width,
        metadata.height,
        metadata.duration,
        metadata.duration,
    );
    let title = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("本地视频")
        .to_owned();
    let connection = open(&app)?;
    let id = format!("VIDTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, duration, width, height, aspect_ratio,
                mode, fixed_seconds, status, stage, progress, message, input_json, created_at,
                updated_at, source_kind
             ) VALUES (?1, ?2, ?3, '本地文件', 'UNKNOWN', ?4, ?5, ?6, ?7, ?8, ?9,
                'PENDING', 'queued', 0, ?10, ?11, ?12, ?12, 'LOCAL')",
            params![
                id,
                video_path.to_string_lossy(),
                title,
                metadata.duration,
                metadata.width,
                metadata.height,
                metadata.aspect_ratio,
                input.mode,
                input.fixed_seconds,
                format!(
                    "已读取完整视频：{:.1}秒，已加入后台理解队列",
                    metadata.duration
                ),
                input_json,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    spawn_local_task(app.clone(), id.clone());
    get_task(&app, &id)
}

#[tauri::command]
pub fn save_local_video_understanding_task(
    app: tauri::AppHandle,
    input: SaveLocalVideoUnderstandingTaskInput,
) -> Result<Value, String> {
    if input.video_path.trim().is_empty() {
        return Err("本地视频路径不能为空".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    if input
        .result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .len()
        < 10
    {
        return Err("本地视频理解结果为空".to_owned());
    }
    if input
        .aspect_ratio
        .as_deref()
        .is_some_and(|value| !matches!(value, "9:16" | "16:9"))
    {
        return Err("视频画面比例必须是9:16或16:9".to_owned());
    }
    let path = PathBuf::from(input.video_path.trim());
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("本地视频")
        .to_owned();
    let connection = open(&app)?;
    let id = format!("VIDTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&json!({
        "video_path": input.video_path,
        "mode": input.mode,
        "fixed_seconds": input.fixed_seconds,
        "duration": input.duration,
        "aspect_ratio": input.aspect_ratio,
    }))
    .map_err(|error| error.to_string())?;
    let result_json = serde_json::to_string(&input.result).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, duration, aspect_ratio, mode, fixed_seconds,
                status, stage, progress, message, input_json, result_json, created_at, updated_at,
                finished_at, source_kind
             ) VALUES (?1, ?2, ?3, '本地文件', 'UNKNOWN', ?4, ?5, ?6, ?7,
                'COMPLETED', 'completed', 1, '视频理解与分镜生成完成', ?8, ?9, ?10, ?10, ?10, 'LOCAL')",
            params![
                id,
                path.to_string_lossy(),
                title,
                input.duration,
                input.aspect_ratio,
                input.mode,
                input.fixed_seconds,
                input_json,
                result_json,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get_task(&app, &id)
}

#[tauri::command]
pub fn retry_douyin_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Value, String> {
    let connection = open(&app)?;
    let changed = connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入队列', error_json = NULL, finished_at = NULL, updated_at = ?2
             WHERE id = ?1 AND source_kind = 'LINK' AND status = 'FAILED'",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有失败的任务可以重试".to_owned());
    }
    drop(connection);
    spawn_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn retry_local_video_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Value, String> {
    let connection = open(&app)?;
    let changed = connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入本地视频理解队列', error_json = NULL, finished_at = NULL,
             updated_at = ?2 WHERE id = ?1 AND source_kind = 'LOCAL' AND status = 'FAILED'",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有失败的本地视频理解任务可以重试".to_owned());
    }
    drop(connection);
    spawn_local_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn delete_video_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let mut connection = open(&app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM video_remix_tasks WHERE source_task_id = ?1",
            [&task_id],
        )
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "DELETE FROM douyin_understanding_tasks WHERE id = ?1",
            [&task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("视频解析或理解记录不存在".to_owned());
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let connection = open(app)?;
    connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '应用已恢复任务，等待重新执行', updated_at = ?1
             WHERE status = 'RUNNING'",
            [Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, source_kind FROM douyin_understanding_tasks WHERE status = 'PENDING'")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);
    for (id, source_kind) in ids {
        if source_kind == "LOCAL" {
            spawn_local_task(app.clone(), id);
        } else {
            spawn_task(app.clone(), id);
        }
    }
    Ok(())
}
