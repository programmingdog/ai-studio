use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, sync::OnceLock, time::Duration};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
pub struct CreateScriptAnalysisTaskInput {
    source_path: String,
    root_path: String,
    creation_spec: Value,
    expected_credits: f64,
    platform_api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScriptAnalysisTask {
    id: String,
    source_path: String,
    source_name: String,
    root_path: String,
    creation_spec: Value,
    requested_project_name: String,
    status: String,
    progress: f64,
    stage: String,
    message: String,
    expected_credits: f64,
    project_id: Option<String>,
    project_path: Option<String>,
    project_name: Option<String>,
    error: Option<String>,
    attempt: i64,
    created_at: String,
    updated_at: String,
    finished_at: Option<String>,
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let path = crate::platform_session::user_scoped_sqlite(app, "script-analysis.db")?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection.busy_timeout(Duration::from_secs(30)).map_err(|error| error.to_string())?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS script_analysis_tasks (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL DEFAULT '',
           source_path TEXT NOT NULL,
           source_name TEXT NOT NULL,
           root_path TEXT NOT NULL,
           creation_spec_json TEXT NOT NULL,
           requested_project_name TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL,
           progress REAL NOT NULL DEFAULT 0,
           stage TEXT NOT NULL DEFAULT 'queued',
           message TEXT NOT NULL DEFAULT '',
           expected_credits REAL NOT NULL DEFAULT 0,
           platform_api_base_url TEXT,
           idempotency_key TEXT NOT NULL,
           run_id TEXT NOT NULL DEFAULT '',
           project_id TEXT,
           project_path TEXT,
           project_name TEXT,
           error TEXT,
           attempt INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           finished_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_script_analysis_tasks_created ON script_analysis_tasks(created_at DESC);",
    ).map_err(|error| error.to_string())?;
    let has_run_id: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('script_analysis_tasks') WHERE name='run_id')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !has_run_id { connection.execute("ALTER TABLE script_analysis_tasks ADD COLUMN run_id TEXT NOT NULL DEFAULT ''", []).map_err(|error| error.to_string())?; }
    crate::platform_session::bind_user_owned_tables(&connection, &["script_analysis_tasks"])?;
    Ok(connection)
}

fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScriptAnalysisTask> {
    let raw: String = row.get(4)?;
    Ok(ScriptAnalysisTask {
        id: row.get(0)?, source_path: row.get(1)?, source_name: row.get(2)?, root_path: row.get(3)?,
        creation_spec: serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
        requested_project_name: row.get(5)?, status: row.get(6)?, progress: row.get(7)?, stage: row.get(8)?, message: row.get(9)?,
        expected_credits: row.get(10)?, project_id: row.get(11)?, project_path: row.get(12)?, project_name: row.get(13)?,
        error: row.get(14)?, attempt: row.get(15)?, created_at: row.get(16)?, updated_at: row.get(17)?, finished_at: row.get(18)?,
    })
}

const SELECT: &str = "SELECT id, source_path, source_name, root_path, creation_spec_json, requested_project_name,
 status, progress, stage, message, expected_credits, project_id, project_path, project_name, error, attempt,
 created_at, updated_at, finished_at FROM script_analysis_tasks";

fn find(app: &AppHandle, id: &str) -> Result<Option<ScriptAnalysisTask>, String> {
    let connection = open(app)?;
    let user_id = crate::platform_session::current_user_id()?;
    connection.query_row(&format!("{SELECT} WHERE id = ?1 AND user_id = ?2"), params![id, user_id], row)
        .optional().map_err(|error| error.to_string())
}

fn update(app: &AppHandle, id: &str, status: &str, progress: f64, stage: &str, message: &str) -> Result<(), String> {
    let connection = open(app)?;
    let user_id = crate::platform_session::current_user_id()?;
    connection.execute(
        "UPDATE script_analysis_tasks SET status=?1, progress=?2, stage=?3, message=?4, updated_at=?5 WHERE id=?6 AND user_id=?7",
        params![status, progress, stage, message, Utc::now().to_rfc3339(), id, user_id],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn readable_error(error: String) -> String {
    serde_json::from_str::<Value>(&error).ok()
        .and_then(|value| value.get("message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or(error)
}

fn project_title(task: &ScriptAnalysisTask, analysis: &Value) -> String {
    let requested = task.requested_project_name.trim();
    if !requested.is_empty() { return requested.chars().take(80).collect(); }
    let extracted = analysis.pointer("/story/title").and_then(Value::as_str).unwrap_or("").trim();
    if !extracted.is_empty() && extracted != "未命名剧本" { return extracted.chars().take(80).collect(); }
    Path::new(&task.source_name).file_stem().and_then(|value| value.to_str()).filter(|value| !value.trim().is_empty())
        .unwrap_or("未命名剧本").chars().take(80).collect()
}

fn create_project_from_analysis(app: &AppHandle, task: &ScriptAnalysisTask, analysis: Value) -> Result<(String, String, String), String> {
    let title = project_title(task, &analysis);
    let mut spec = task.creation_spec.clone();
    if let Some(object) = spec.as_object_mut() { object.remove("platform_api_base_url"); }
    spec["project_name"] = json!(title);
    spec["input_type"] = json!("SCRIPT");
    let duration: f64 = analysis.get("shots").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|shot| shot.get("duration").and_then(Value::as_f64)).filter(|value| *value > 0.0).sum();
    spec["target_duration"] = json!(duration);
    let bundle = crate::project::manager::create(crate::project::manager::CreateProjectInput {
        root_path: task.root_path.clone(), source_type: "SCRIPT_FILE".to_owned(), source_text: None,
        source_path: Some(task.source_path.clone()), creation_spec: spec,
    })?;
    let project_id = bundle.pointer("/project/id").and_then(Value::as_str).ok_or("创建后的项目缺少 ID")?.to_owned();
    let project_path = bundle.pointer("/project/project_path").and_then(Value::as_str).ok_or("创建后的项目缺少路径")?.to_owned();
    let mut connection = crate::database::open(&PathBuf::from(&project_path))?;
    let job_id = crate::jobs::create(&connection, &project_id, "ANALYZE_SCRIPT", &json!({"source": "SERVER_TEXT_MODEL", "strict_extraction": true}))?;
    crate::jobs::update(&connection, &job_id, "RUNNING", 0.95, Some("persisting"), Some("正在保存剧本提取结果"))?;
    crate::database::repository::save_canonical(&mut connection, &project_id, &analysis)?;
    crate::jobs::update(&connection, &job_id, "COMPLETED", 1.0, Some("completed"), Some("剧本忠实提取完成"))?;
    let completed = crate::database::repository::load_bundle(&connection)?;
    crate::project::registry::register(app, &completed, false)?;
    Ok((project_id, project_path, title))
}

fn spawn(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(task) = find(&app, &id).ok().flatten() else { return; };
        if !Path::new(&task.source_path).is_file() {
            let _ = fail(&app, &id, "原剧本文件已不存在，请重新选择剧本"); return;
        }
        let _ = update(&app, &id, "UPLOADING", 0.08, "uploading", "正在上传完整剧本文件");
        let idempotency = {
            let connection = match open(&app) { Ok(value) => value, Err(error) => { let _ = fail(&app, &id, &error); return; } };
            connection.query_row("SELECT idempotency_key FROM script_analysis_tasks WHERE id=?1", [&id], |row| row.get::<_, String>(0)).unwrap_or_default()
        };
        let mut request = Box::pin(crate::platform_script_analysis::analyze_file(
            task.creation_spec.get("platform_api_base_url").and_then(Value::as_str).or(None),
            Path::new(&task.source_path), task.expected_credits, &idempotency,
        ));
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        let mut progress = 0.12_f64;
        let result = loop {
            tokio::select! {
                result = &mut request => break result,
                _ = interval.tick() => {
                    progress = (progress + (0.9 - progress) * 0.035).min(0.89);
                    let _ = update(&app, &id, "RUNNING", progress, "model_analysis", "文本大模型正在忠实提取剧情、场景、角色和分镜");
                }
            }
        };
        let value = match result { Ok(value) => value, Err(error) => { let _ = fail(&app, &id, &readable_error(error)); return; } };
        let Some(analysis) = value.get("analysis").cloned() else { let _ = fail(&app, &id, "服务端没有返回完整的剧本提取结果"); return; };
        let _ = update(&app, &id, "POST_PROCESSING", 0.94, "creating_project", "正在创建本地项目并写入提取结果");
        let app_for_project = app.clone();
        let task_for_project = task.clone();
        let project = tauri::async_runtime::spawn_blocking(move || create_project_from_analysis(&app_for_project, &task_for_project, analysis)).await;
        match project {
            Ok(Ok((project_id, project_path, project_name))) => {
                if let Ok(connection) = open(&app) {
                    let user_id = crate::platform_session::current_user_id().unwrap_or_default();
                    let now = Utc::now().to_rfc3339();
                    let _ = connection.execute("UPDATE script_analysis_tasks SET status='COMPLETED', progress=1, stage='completed', message='剧本分析与项目创建完成', project_id=?1, project_path=?2, project_name=?3, error=NULL, updated_at=?4, finished_at=?4 WHERE id=?5 AND user_id=?6",
                        params![project_id, project_path, project_name, now, id, user_id]);
                }
            }
            Ok(Err(error)) => { let _ = fail(&app, &id, &error); }
            Err(error) => { let _ = fail(&app, &id, &format!("创建项目线程失败：{error}")); }
        }
    });
}

fn fail(app: &AppHandle, id: &str, error: &str) -> Result<(), String> {
    let connection = open(app)?;
    let user_id = crate::platform_session::current_user_id()?;
    let now = Utc::now().to_rfc3339();
    connection.execute("UPDATE script_analysis_tasks SET status='FAILED', stage='failed', message='剧本分析失败', error=?1, updated_at=?2, finished_at=?2 WHERE id=?3 AND user_id=?4",
        params![error, now, id, user_id]).map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_source(path: &str) -> Result<String, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_file() { return Err("请选择存在的剧本文件".to_owned()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "txt" | "md" | "docx" | "pdf") { return Err("仅支持 TXT、MD、DOCX 或 PDF 剧本文件".to_owned()); }
    Ok(path.file_name().and_then(|value| value.to_str()).unwrap_or("剧本文件").to_owned())
}

#[tauri::command]
pub fn create_script_analysis_task(app: AppHandle, input: CreateScriptAnalysisTaskInput) -> Result<ScriptAnalysisTask, String> {
    let source_name = validate_source(&input.source_path)?;
    if input.root_path.trim().is_empty() { return Err("请选择项目保存目录".to_owned()); }
    if !input.expected_credits.is_finite() || input.expected_credits < 0.0 { return Err("剧本提取积分无效".to_owned()); }
    let id = uuid::Uuid::new_v4().to_string();
    let user_id = crate::platform_session::current_user_id()?;
    let now = Utc::now().to_rfc3339();
    let requested_project_name = input.creation_spec.get("project_name").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    let mut spec = input.creation_spec;
    if let Some(base_url) = input.platform_api_base_url.as_deref().filter(|value| !value.trim().is_empty()) { spec["platform_api_base_url"] = json!(base_url); }
    let connection = open(&app)?;
    connection.execute("INSERT INTO script_analysis_tasks(id,user_id,source_path,source_name,root_path,creation_spec_json,requested_project_name,status,progress,stage,message,expected_credits,platform_api_base_url,idempotency_key,run_id,attempt,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'PENDING',0,'queued','等待上传剧本',?8,?9,?10,?11,1,?12,?12)",
        params![id, user_id, input.source_path, source_name, input.root_path, spec.to_string(), requested_project_name, input.expected_credits, input.platform_api_base_url, uuid::Uuid::new_v4().to_string(), run_id(), now])
        .map_err(|error| error.to_string())?;
    let task = find(&app, &id)?.ok_or("剧本任务创建失败")?;
    spawn(app, id);
    Ok(task)
}

#[tauri::command]
pub fn list_script_analysis_tasks(app: AppHandle) -> Result<Vec<ScriptAnalysisTask>, String> {
    let connection = open(&app)?;
    let user_id = crate::platform_session::current_user_id()?;
    let mut statement = connection.prepare(&format!("{SELECT} WHERE user_id=?1 ORDER BY created_at DESC")).map_err(|error| error.to_string())?;
    let items = statement.query_map([user_id], row).map_err(|error| error.to_string())?
        .map(|item| item.map_err(|error| error.to_string())).collect();
    items
}

#[tauri::command]
pub fn reanalyze_script_task(app: AppHandle, task_id: String, expected_credits: f64, platform_api_base_url: Option<String>) -> Result<ScriptAnalysisTask, String> {
    let task = find(&app, &task_id)?.ok_or("剧本分析记录不存在")?;
    if ["PENDING", "UPLOADING", "RUNNING", "POST_PROCESSING"].contains(&task.status.as_str()) { return Err("该剧本正在分析中".to_owned()); }
    create_script_analysis_task(app, CreateScriptAnalysisTaskInput {
        source_path: task.source_path, root_path: task.root_path, creation_spec: task.creation_spec,
        expected_credits, platform_api_base_url,
    })
}

#[tauri::command]
pub fn delete_script_analysis_task(app: AppHandle, task_id: String) -> Result<(), String> {
    let task = find(&app, &task_id)?.ok_or("剧本分析记录不存在")?;
    if ["PENDING", "UPLOADING", "RUNNING", "POST_PROCESSING"].contains(&task.status.as_str()) { return Err("分析进行中，暂时不能删除记录".to_owned()); }
    let connection = open(&app)?;
    let user_id = crate::platform_session::current_user_id()?;
    connection.execute("DELETE FROM script_analysis_tasks WHERE id=?1 AND user_id=?2", params![task_id, user_id]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let connection = open(app)?;
    let user_id = crate::platform_session::current_user_id()?;
    let now = Utc::now().to_rfc3339();
    connection.execute("UPDATE script_analysis_tasks SET status='FAILED', stage='interrupted', message='应用退出导致分析中断', error='上次分析被应用退出中断，请重新分析', updated_at=?1, finished_at=?1 WHERE user_id=?2 AND run_id<>?3 AND status IN ('PENDING','UPLOADING','RUNNING','POST_PROCESSING')", params![now, user_id, run_id()]).map_err(|error| error.to_string())?;
    Ok(())
}
