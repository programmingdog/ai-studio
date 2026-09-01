use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc};
use tauri::Manager;

use crate::{
    database, jobs,
    project::{manager::CreateProjectInput, registry},
    worker::python::{self, WorkerEvent},
};

#[derive(Debug, Deserialize)]
pub struct CreateAutomaticWorkflowInput {
    project_path: String,
    project_id: String,
    mode: String,
    resolution: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAutomaticWorkflowInput {
    project_path: String,
    project_id: String,
    workflow_id: String,
    status: String,
    stage: String,
    progress: f64,
    message: String,
    retry_message: Option<String>,
    snapshot: Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateIdeaDevelopmentWorkflowInput {
    project_path: String,
    project_id: String,
    workflow_id: String,
    action: String,
    #[serde(default)]
    payload: Value,
}

#[tauri::command]
pub fn create_project(app: tauri::AppHandle, input: CreateProjectInput) -> Result<Value, String> {
    let bundle = crate::project::manager::create(input)?;
    registry::register(&app, &bundle, false)?;
    Ok(bundle)
}

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Value, String> {
    crate::background::run("读取项目列表", move || registry::list(&app)).await
}

#[tauri::command]
pub async fn list_asset_library(
    app: tauri::AppHandle,
) -> Result<Vec<database::asset_library::AssetLibraryItem>, String> {
    crate::background::run("读取资产库", move || {
        database::asset_library::list(&app)
    })
    .await
}

#[tauri::command]
pub fn delete_asset_library(
    app: tauri::AppHandle,
    asset_ids: Vec<String>,
) -> Result<database::asset_library::DeleteAssetLibraryResult, String> {
    database::asset_library::delete(&app, asset_ids)
}

#[tauri::command]
pub fn delete_project(app: tauri::AppHandle, project_id: String) -> Result<Value, String> {
    let record = registry::find(&app, project_id.trim())?.ok_or("项目不存在或已经被移除")?;
    if record.is_example {
        return Err("内置示例项目不能删除".to_owned());
    }
    let raw_path = PathBuf::from(&record.project_path);
    if !raw_path.join("project.json").is_file() || !raw_path.join("project.db").is_file() {
        return Err("项目目录无效，已停止删除".to_owned());
    }
    let ownership_check = database::open(&raw_path)?;
    drop(ownership_check);
    let target =
        fs::canonicalize(&raw_path).map_err(|error| format!("无法确认项目目录：{error}"))?;
    let parent = target.parent().ok_or("项目目录不能是磁盘根目录")?;
    if target == parent || target.components().count() < 3 {
        return Err("项目目录范围过大，已停止删除".to_owned());
    }
    let preserved_assets = database::asset_library::sync_project_images(&app, &target)?;
    fs::remove_dir_all(&target).map_err(|error| format!("删除项目目录失败：{error}"))?;
    registry::unregister(&app, &record.id)?;
    Ok(json!({
        "project_id": record.id,
        "project_name": record.name,
        "deleted_path": target.to_string_lossy(),
        "preserved_assets": preserved_assets,
    }))
}

#[tauri::command]
pub async fn load_project(app: tauri::AppHandle, project_path: String) -> Result<Value, String> {
    crate::background::run("读取并初始化项目", move || {
        let path = PathBuf::from(project_path);
        if !path.join("project.json").is_file() || !path.join("project.db").is_file() {
            return Err(
                "所选目录不是有效的 AI Video Studio 项目（缺少 project.json 或 project.db）".into(),
            );
        }
        let connection = database::open(&path)?;
        let bundle = database::repository::load_bundle(&connection)?;
        drop(connection);
        crate::ai::resume_project_image_tasks(&app, &path)?;
        crate::ai::resume_project_video_tasks(&path)?;
        registry::register(&app, &bundle, false)?;
        Ok(bundle)
    })
    .await
}

#[tauri::command]
pub fn save_text_file(output_path: String, content: String) -> Result<String, String> {
    if content.len() > 10 * 1024 * 1024 {
        return Err("TXT 内容不能超过 10 MB".into());
    }
    let path = PathBuf::from(output_path.trim());
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
    {
        return Err("请选择有效的绝对 TXT 保存路径".into());
    }
    let parent = path.parent().ok_or("TXT 保存目录无效")?;
    if !parent.is_dir() {
        return Err("TXT 保存目录不存在".into());
    }
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| format!("保存 TXT 文件失败：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn import_project_reference_image(
    project_path: String,
    source_path: String,
    owner_type: String,
    owner_id: String,
) -> Result<String, String> {
    let project_root = PathBuf::from(project_path);
    if !project_root.join("project.json").is_file() || !project_root.join("project.db").is_file() {
        return Err("项目目录无效，无法导入参考图".to_owned());
    }
    let asset_directory = match owner_type.as_str() {
        "character_state" => "characters",
        "scene" => "scenes",
        _ => return Err("参考图所属类型无效".to_owned()),
    };
    let source = fs::canonicalize(PathBuf::from(source_path))
        .map_err(|error| format!("无法读取所选图片：{error}"))?;
    if !source.is_file() {
        return Err("所选路径不是有效图片文件".to_owned());
    }
    let bytes = fs::read(&source).map_err(|error| format!("读取所选图片失败：{error}"))?;
    if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 {
        return Err("图片为空或超过 40MB".to_owned());
    }
    let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else {
        return Err("仅支持 PNG、JPG/JPEG 或 WebP 图片".to_owned());
    };
    let safe_owner_id = owner_id
        .trim()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '_' | '-') {
                value
            } else {
                '_'
            }
        })
        .take(96)
        .collect::<String>();
    if safe_owner_id.is_empty() {
        return Err("参考图所属对象无效".to_owned());
    }
    let relative_directory = format!("assets/imported/{asset_directory}");
    let destination_directory = project_root.join(&relative_directory);
    fs::create_dir_all(&destination_directory)
        .map_err(|error| format!("创建项目参考图目录失败：{error}"))?;
    let file_name = format!(
        "{}_{}.{}",
        safe_owner_id,
        uuid::Uuid::new_v4().simple(),
        extension
    );
    fs::copy(&source, destination_directory.join(&file_name))
        .map_err(|error| format!("复制参考图到项目失败：{error}"))?;
    Ok(format!("{relative_directory}/{file_name}"))
}

#[tauri::command]
pub fn save_canonical_project(
    project_path: String,
    project_id: String,
    canonical: Value,
) -> Result<Value, String> {
    let mut connection = database::open(&PathBuf::from(project_path))?;
    database::repository::save_canonical(&mut connection, &project_id, &canonical)?;
    database::repository::load_bundle(&connection)
}

#[tauri::command]
pub fn create_automatic_workflow(
    input: CreateAutomaticWorkflowInput,
) -> Result<crate::database::automatic_workflows::AutomaticWorkflow, String> {
    if !matches!(input.mode.as_str(), "fast" | "storyboard") {
        return Err("自动制作模式无效".to_owned());
    }
    let connection = database::open(&PathBuf::from(input.project_path))?;
    crate::database::automatic_workflows::create(
        &connection,
        &input.project_id,
        &input.mode,
        input.resolution.trim(),
    )
}

#[tauri::command]
pub async fn get_active_automatic_workflow(
    project_path: String,
    project_id: String,
) -> Result<Option<crate::database::automatic_workflows::AutomaticWorkflow>, String> {
    crate::background::run("读取自动制作任务", move || {
        let connection = database::open(&PathBuf::from(project_path))?;
        crate::database::automatic_workflows::get_active(&connection, &project_id)
    })
    .await
}

#[tauri::command]
pub fn update_automatic_workflow(
    input: UpdateAutomaticWorkflowInput,
) -> Result<crate::database::automatic_workflows::AutomaticWorkflow, String> {
    if !matches!(
        input.status.as_str(),
        "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED"
    ) {
        return Err("自动制作工作流状态无效".to_owned());
    }
    if !matches!(
        input.stage.as_str(),
        "assets" | "storyboard" | "video" | "composition" | "completed"
    ) {
        return Err("自动制作工作流阶段无效".to_owned());
    }
    let connection = database::open(&PathBuf::from(input.project_path))?;
    crate::database::automatic_workflows::update(
        &connection,
        &input.workflow_id,
        &input.project_id,
        &input.status,
        &input.stage,
        input.progress,
        input.message.trim(),
        input.retry_message.as_deref(),
        &input.snapshot,
    )
}

#[tauri::command]
pub async fn develop_idea(
    app: tauri::AppHandle,
    project_path: String,
    project_id: String,
    idea: String,
    creation_spec: Value,
) -> Result<Value, String> {
    crate::guided_idea::start(
        &app,
        PathBuf::from(project_path),
        project_id,
        idea,
        creation_spec,
    )
    .await
}

#[tauri::command]
pub async fn update_idea_development_workflow(
    app: tauri::AppHandle,
    input: UpdateIdeaDevelopmentWorkflowInput,
) -> Result<crate::database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    crate::guided_idea::apply_action(
        &app,
        PathBuf::from(input.project_path),
        input.project_id,
        input.workflow_id,
        input.action,
        input.payload,
    )
    .await
}

#[tauri::command]
pub async fn get_idea_development_workflow(
    project_path: String,
    project_id: String,
) -> Result<Option<crate::database::idea_workflows::IdeaDevelopmentWorkflow>, String> {
    crate::background::run("读取创意开发任务", move || {
        let connection = database::open(&PathBuf::from(project_path))?;
        crate::database::idea_workflows::latest(&connection, &project_id)
    })
    .await
}

#[tauri::command]
pub fn analyze_script(
    project_path: String,
    project_id: String,
    source_text: String,
    source_path: Option<String>,
    creation_spec: Value,
) -> Result<Value, String> {
    let project_root = PathBuf::from(&project_path);
    let mut connection = database::open(&project_root)?;
    let resolved_source = source_path.map(|relative| project_root.join(relative));
    let payload = json!({"source_path": resolved_source, "has_source_text": !source_text.is_empty(), "creation_spec": creation_spec});
    let job_id = jobs::create(&connection, &project_id, "ANALYZE_SCRIPT", &payload)?;
    jobs::update(
        &connection,
        &job_id,
        "PREPARING",
        0.02,
        Some("worker_start"),
        Some("正在启动剧本分析 Worker"),
    )?;
    jobs::update(
        &connection,
        &job_id,
        "RUNNING",
        0.03,
        Some("script_read"),
        Some("正在读取剧本"),
    )?;
    let text = if source_text.trim().is_empty() {
        None
    } else {
        Some(source_text.as_str())
    };
    let events = match python::analyze_script(text, resolved_source.as_deref(), &creation_spec) {
        Ok(events) => events,
        Err(message) => {
            let error =
                json!({"code": "PYTHON_WORKER_ERROR", "message": message, "retryable": true});
            jobs::fail(&connection, &job_id, &error)?;
            return Err(error.to_string());
        }
    };
    let mut canonical = None;
    for event in events {
        match event {
            WorkerEvent::Progress {
                value,
                stage,
                message,
            } => jobs::update(
                &connection,
                &job_id,
                "RUNNING",
                value,
                Some(&stage),
                Some(&message),
            )?,
            WorkerEvent::Result(data) => canonical = Some(data),
            WorkerEvent::Error(error) => {
                jobs::fail(&connection, &job_id, &error)?;
                return Err(error.to_string());
            }
        }
    }
    let canonical = canonical.ok_or("Python worker returned no script result")?;
    database::repository::save_canonical(&mut connection, &project_id, &canonical)?;
    jobs::update(
        &connection,
        &job_id,
        "COMPLETED",
        1.0,
        Some("completed"),
        Some("剧本分析完成"),
    )?;
    database::repository::load_bundle(&connection)
}

#[tauri::command]
pub async fn resolve_douyin_url(
    share_text: String,
    browser_cookie_source: Option<String>,
    cookie_file_path: Option<String>,
) -> Result<Value, String> {
    if share_text.trim().is_empty() {
        return Err(json!({"code": "DOUYIN_URL_REQUIRED", "message": "请输入视频分享链接或分享文案", "retryable": false}).to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let events = python::resolve_douyin(
            &share_text,
            browser_cookie_source.as_deref(),
            cookie_file_path.as_deref(),
        )?;
        worker_result(events, "DOUYIN_EMPTY_RESULT", "解析器没有返回结果")
    })
    .await
    .map_err(|error| background_task_error("DOUYIN_RESOLVE_TASK_ERROR", "视频链接解析", error))?
}

#[tauri::command]
pub async fn resolve_douyin_auto(
    app: tauri::AppHandle,
    share_text: String,
) -> Result<Value, String> {
    if share_text.trim().is_empty() {
        return Err(json!({"code": "DOUYIN_URL_REQUIRED", "message": "请输入视频分享链接或分享文案", "retryable": false}).to_string());
    }
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("douyin-managed-chrome");
    tauri::async_runtime::spawn_blocking(move || {
        let events = python::resolve_douyin_auto(&share_text, &profile_root)?;
        worker_result(events, "DOUYIN_EMPTY_RESULT", "自动登录解析器没有返回结果")
    })
    .await
    .map_err(|error| {
        background_task_error(
            "DOUYIN_AUTO_RESOLVE_TASK_ERROR",
            "视频链接自动检测与解析",
            error,
        )
    })?
}

#[tauri::command]
pub async fn get_douyin_browser_availability() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worker_result(
            python::douyin_browser_availability()?,
            "DOUYIN_BROWSER_CHECK_FAILED",
            "浏览器检测没有返回结果",
        )
    })
    .await
    .map_err(|error| background_task_error("DOUYIN_BROWSER_TASK_ERROR", "浏览器检测", error))?
}

#[tauri::command]
pub async fn download_douyin_video(
    share_text: String,
    output_path: String,
    browser_cookie_source: Option<String>,
    cookie_file_path: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let events = python::download_douyin(
            &share_text,
            &PathBuf::from(output_path),
            browser_cookie_source.as_deref(),
            cookie_file_path.as_deref(),
        )?;
        worker_result(events, "DOUYIN_DOWNLOAD_EMPTY_RESULT", "下载器没有返回结果")
    })
    .await
    .map_err(|error| background_task_error("DOUYIN_DOWNLOAD_TASK_ERROR", "短视频下载", error))?
}

#[tauri::command]
pub async fn download_douyin_video_auto(
    app: tauri::AppHandle,
    share_text: String,
    output_path: String,
) -> Result<Value, String> {
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("douyin-managed-chrome");
    tauri::async_runtime::spawn_blocking(move || {
        let events =
            python::download_douyin_auto(&share_text, &PathBuf::from(output_path), &profile_root)?;
        worker_result(
            events,
            "DOUYIN_DOWNLOAD_EMPTY_RESULT",
            "自动下载器没有返回结果",
        )
    })
    .await
    .map_err(|error| {
        background_task_error("DOUYIN_AUTO_DOWNLOAD_TASK_ERROR", "短视频自动下载", error)
    })?
}

fn worker_result(
    events: Vec<WorkerEvent>,
    empty_code: &str,
    empty_message: &str,
) -> Result<Value, String> {
    for event in events {
        match event {
            WorkerEvent::Result(data) => return Ok(data),
            WorkerEvent::Error(error) => return Err(error.to_string()),
            WorkerEvent::Progress { .. } => {}
        }
    }
    Err(json!({"code": empty_code, "message": empty_message, "retryable": true}).to_string())
}

fn background_task_error(code: &str, operation: &str, error: impl std::fmt::Display) -> String {
    json!({
        "code": code,
        "message": format!("{operation}后台任务异常：{error}"),
        "retryable": true
    })
    .to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct DouyinStoryboardInput {
    pub(crate) share_text: String,
    pub(crate) prompt: String,
    pub(crate) source_width: Option<u64>,
    pub(crate) source_height: Option<u64>,
    pub(crate) aspect_ratio: Option<String>,
    #[serde(default)]
    pub(crate) managed: bool,
    pub(crate) browser_cookie_source: Option<String>,
    pub(crate) cookie_file_path: Option<String>,
}

#[tauri::command]
pub async fn analyze_douyin_video(
    app: tauri::AppHandle,
    input: DouyinStoryboardInput,
) -> Result<crate::ai::VideoUnderstandingResult, String> {
    tauri::async_runtime::spawn(async move { analyze_douyin_video_task(app, input).await })
        .await
        .map_err(|error| {
            background_task_error("DOUYIN_STORYBOARD_TASK_ERROR", "下载并理解链接视频", error)
        })?
}

async fn analyze_douyin_video_task(
    app: tauri::AppHandle,
    input: DouyinStoryboardInput,
) -> Result<crate::ai::VideoUnderstandingResult, String> {
    analyze_douyin_video_task_with_progress(app, input, Arc::new(|_, _, _| {})).await
}

pub(crate) async fn analyze_douyin_video_task_with_progress(
    app: tauri::AppHandle,
    input: DouyinStoryboardInput,
    progress: Arc<dyn Fn(&str, f64, &str) + Send + Sync>,
) -> Result<crate::ai::VideoUnderstandingResult, String> {
    if input.share_text.trim().is_empty() {
        return Err(json!({"code": "DOUYIN_URL_REQUIRED", "message": "请输入视频分享链接或分享文案", "retryable": false}).to_string());
    }
    if input.prompt.trim().len() < 10 {
        return Err(json!({"code": "VIDEO_PROMPT_REQUIRED", "message": "视频分析提示词不能少于 10 个字符", "retryable": false}).to_string());
    }
    let enforced_aspect_ratio = match input.aspect_ratio.as_deref() {
        Some("9:16") => Some("9:16"),
        Some("16:9") => Some("16:9"),
        Some(_) => {
            return Err(json!({"code": "VIDEO_ASPECT_RATIO_INVALID", "message": "视频画面比例必须是 9:16 或 16:9", "retryable": false}).to_string());
        }
        None => match (input.source_width, input.source_height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                Some(if width > height { "16:9" } else { "9:16" })
            }
            _ => None,
        },
    };
    let analysis_prompt = if let Some(aspect_ratio) = enforced_aspect_ratio {
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
    };

    let temp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("douyin-storyboard-temp");
    std::fs::create_dir_all(&temp_dir).map_err(|error| {
        json!({"code": "DOUYIN_TEMP_DIR_ERROR", "message": format!("无法创建临时视频目录：{error}"), "retryable": true}).to_string()
    })?;
    let temp_path = temp_dir.join(format!("{}.mp4", uuid::Uuid::new_v4().simple()));
    let download_path = temp_path.clone();
    let share_text = input.share_text;
    let managed = input.managed;
    let browser_cookie_source = input.browser_cookie_source;
    let cookie_file_path = input.cookie_file_path;
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("douyin-managed-chrome");

    progress("downloading", 0.2, "正在下载视频");
    let download = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let events = if managed {
            python::download_douyin_auto(&share_text, &download_path, &profile_root)?
        } else {
            python::download_douyin(
                &share_text,
                &download_path,
                browser_cookie_source.as_deref(),
                cookie_file_path.as_deref(),
            )?
        };
        for event in events {
            match event {
                WorkerEvent::Result(_) => return Ok(()),
                WorkerEvent::Error(error) => return Err(error.to_string()),
                WorkerEvent::Progress { .. } => {}
            }
        }
        Err(json!({"code": "DOUYIN_DOWNLOAD_EMPTY_RESULT", "message": "临时下载没有返回结果", "retryable": true}).to_string())
    })
    .await
    .map_err(|error| {
        json!({"code": "DOUYIN_DOWNLOAD_TASK_ERROR", "message": format!("临时下载任务异常：{error}"), "retryable": true}).to_string()
    })?;

    if let Err(error) = download {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error);
    }
    let mut analysis_path = temp_path.clone();
    let compressed_path = temp_dir.join(format!("{}-ai.mp4", uuid::Uuid::new_v4().simple()));
    let downloaded_size = tokio::fs::metadata(&temp_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if downloaded_size > crate::ai::LINGKE_INLINE_TARGET {
        progress("compressing", 0.48, "视频较大，正在压缩分析副本");
        let source = temp_path.clone();
        let destination = compressed_path.clone();
        let compression = tauri::async_runtime::spawn_blocking(move || {
            crate::media_tools::compress_video_for_inline_analysis(
                &source,
                &destination,
                crate::ai::LINGKE_INLINE_TARGET,
            )
        })
        .await
        .map_err(|error| {
            json!({"code": "VIDEO_COMPRESSION_TASK_ERROR", "message": format!("视频压缩任务异常：{error}"), "retryable": true}).to_string()
        })?;
        if let Err(error) = compression {
            let _ = tokio::fs::remove_file(&temp_path).await;
            let _ = tokio::fs::remove_file(&compressed_path).await;
            return Err(error);
        }
        analysis_path = compressed_path.clone();
    }

    progress("analyzing", 0.62, "AI正在理解视频并生成分镜脚本");
    let analysis = crate::ai::analyze_video_path(&app, &analysis_path, &analysis_prompt).await;
    let _ = tokio::fs::remove_file(&temp_path).await;
    let _ = tokio::fs::remove_file(&compressed_path).await;
    analysis
}
