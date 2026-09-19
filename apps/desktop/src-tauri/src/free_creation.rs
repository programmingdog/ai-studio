use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const PROJECT_ID: &str = "P_FREE_CREATION";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreeCreationWorkspace {
    project_id: String,
    project_path: String,
}

#[derive(Debug, Deserialize)]
pub struct FreeCreationAssetReference {
    asset_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateFreeCreationVideoInput {
    workspace: FreeCreationWorkspace,
    task_id: String,
    workflow_credit_id: String,
    prompt: String,
    aspect_ratio: String,
    duration: f64,
    resolution: String,
    visual_style_name: String,
    visual_style_prompt: String,
    platform_api_base_url: String,
    provider_model_id: String,
    provider_code: Option<String>,
    model_alias: String,
    #[serde(default)]
    references: Vec<FreeCreationAssetReference>,
}

#[derive(Debug, Deserialize)]
pub struct ComposeFreeCreationVideosInput {
    workspace: FreeCreationWorkspace,
    ordered_record_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FreeCreationTask {
    id: String,
    kind: String,
    prompt: String,
    duration: f64,
    resolution: String,
    visual_style_name: String,
    reference_names: Vec<String>,
    source_record_ids: Vec<String>,
    record: crate::database::generation_records::GenerationRecord,
}

fn create_workspace_files(root: &Path) -> Result<(), String> {
    for relative in ["generated/videos", "temp", "logs", "free-references"] {
        fs::create_dir_all(root.join(relative)).map_err(|error| error.to_string())?;
    }
    let connection = crate::database::open(root)?;
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "INSERT OR IGNORE INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
         VALUES (?1, '自由创作', ?2, 'IDEA', 'ACTIVE', ?3, ?3)",
        params![PROJECT_ID, root.to_string_lossy(), now],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT OR IGNORE INTO project_sources(id, project_id, source_type, source_text, created_at)
         VALUES ('FREE_CREATION_SOURCE', ?1, 'IDEA', '自由创作内部工作区', ?2)",
        params![PROJECT_ID, now],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT OR IGNORE INTO creation_specs(project_id, data_json, updated_at) VALUES (?1, ?2, ?3)",
        params![PROJECT_ID, json!({"project_name":"自由创作","target_duration":10,"aspect_ratio":"9:16","visual_style":""}).to_string(), now],
    ).map_err(|error| error.to_string())?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS free_creation_tasks (
            id TEXT PRIMARY KEY,
            record_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('generation', 'composition')),
            prompt TEXT NOT NULL,
            duration REAL NOT NULL DEFAULT 0,
            resolution TEXT NOT NULL DEFAULT '',
            visual_style_name TEXT NOT NULL DEFAULT '',
            reference_names_json TEXT NOT NULL DEFAULT '[]',
            source_record_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_free_creation_tasks_created ON free_creation_tasks(created_at DESC);"
    ).map_err(|error| error.to_string())?;
    if !root.join("project.json").is_file() {
        let manifest = json!({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "user_id": crate::platform_session::current_user_id()?,
            "name": "自由创作",
            "database": "project.db",
            "source_type": "IDEA",
            "created_at": now,
            "internal": true
        });
        fs::write(
            root.join("project.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn workspace(app: &tauri::AppHandle) -> Result<(PathBuf, FreeCreationWorkspace), String> {
    let root = crate::platform_session::user_scoped_directory(app, "free-creation")?;
    create_workspace_files(&root)?;
    Ok((
        root.clone(),
        FreeCreationWorkspace {
            project_id: PROJECT_ID.to_owned(),
            project_path: root.to_string_lossy().into_owned(),
        },
    ))
}

fn validate_workspace(
    app: &tauri::AppHandle,
    input: &FreeCreationWorkspace,
) -> Result<PathBuf, String> {
    let (root, expected) = workspace(app)?;
    if input.project_id != expected.project_id || PathBuf::from(&input.project_path) != root {
        return Err("自由创作工作区无效，请重新打开自由创作页面".to_owned());
    }
    Ok(root)
}

#[tauri::command]
pub fn ensure_free_creation_workspace(
    app: tauri::AppHandle,
) -> Result<FreeCreationWorkspace, String> {
    let (root, result) = workspace(&app)?;
    crate::ai::resume_project_video_tasks(&app, &root)?;
    Ok(result)
}

fn safe_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "png",
        "webp" => "webp",
        _ => "jpg",
    }
}

#[tauri::command]
pub fn create_free_creation_video(
    app: tauri::AppHandle,
    input: CreateFreeCreationVideoInput,
) -> Result<FreeCreationTask, String> {
    let root = validate_workspace(&app, &input.workspace)?;
    let shot_id = input.task_id.trim().to_owned();
    if !shot_id.starts_with("FREE_")
        || shot_id.len() > 64
        || !shot_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err("自由创作任务编号无效".to_owned());
    }
    if input.workflow_credit_id.trim().is_empty() {
        return Err("自由创作任务缺少积分确认，请重新提交".to_owned());
    }
    let assets = crate::database::asset_library::list(&app)?;
    let asset_by_id: HashMap<_, _> = assets
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect();
    let reference_dir = root.join("free-references").join(&shot_id);
    fs::create_dir_all(&reference_dir).map_err(|error| format!("创建参考图目录失败：{error}"))?;
    let mut references = Vec::new();
    let mut reference_names = Vec::new();
    for (index, reference) in input.references.iter().enumerate() {
        let asset = asset_by_id
            .get(&reference.asset_id)
            .ok_or_else(|| "所选资产已不存在，请重新选择".to_owned())?;
        let source = PathBuf::from(&asset.image_path);
        if !source.is_file() {
            return Err(format!("资产图片不存在：{}", asset.name));
        }
        let extension = safe_extension(&source);
        let relative = format!("free-references/{shot_id}/{index}.{extension}");
        fs::copy(&source, root.join(&relative))
            .map_err(|error| format!("复制资产图片失败：{error}"))?;
        references.push(crate::ai::GenerationReferenceAssetInput {
            relative_path: relative,
            label: asset.name.clone(),
            kind: asset.asset_type.clone(),
            public_url: None,
        });
        reference_names.push(asset.name.clone());
    }

    let now = Utc::now().to_rfc3339();
    let connection = crate::database::open(&root)?;
    let shot_order: i64 = connection
        .query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO shots(id, project_id, shot_order, duration, data_json, status, locked, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT', 0, ?6, ?6)",
        params![shot_id, PROJECT_ID, shot_order, input.duration, json!({"id":shot_id,"duration":input.duration,"visual":input.prompt,"visual_style":input.visual_style_prompt,"video_assets":[]}).to_string(), now],
    ).map_err(|error| error.to_string())?;
    drop(connection);

    let model_prompt = if input.visual_style_prompt.trim().is_empty() {
        input.prompt.trim().to_owned()
    } else {
        format!(
            "{}\n\n画风要求：{}",
            input.prompt.trim(),
            input.visual_style_prompt.trim()
        )
    };
    let record_result = crate::ai::create_shot_video_generation(
        app.clone(),
        crate::ai::CreateShotVideoGenerationInput {
            workflow_credit_id: Some(input.workflow_credit_id.clone()),
            replace_record_id: None,
            project_path: input.workspace.project_path.clone(),
            project_id: PROJECT_ID.to_owned(),
            shot_id: shot_id.clone(),
            prompt: model_prompt,
            aspect_ratio: input.aspect_ratio,
            duration: input.duration,
            resolution: Some(input.resolution.clone()),
            version: None,
            reference_assets: references,
            first_frame_relative_path: None,
            platform_api_base_url: input.platform_api_base_url,
            provider_model_id: input.provider_model_id,
            provider_code: input.provider_code,
            model_alias: input.model_alias,
        },
    );
    let record = match record_result {
        Ok(record) => record,
        Err(error) => {
            if let Ok(connection) = crate::database::open(&root) {
                let _ = connection.execute("DELETE FROM shots WHERE id = ?1", [&shot_id]);
            }
            let _ = fs::remove_dir_all(&reference_dir);
            return Err(error);
        }
    };
    let connection = crate::database::open(&root)?;
    connection.execute(
        "INSERT INTO free_creation_tasks(id, record_id, kind, prompt, duration, resolution, visual_style_name, reference_names_json, source_record_ids_json, created_at)
         VALUES (?1, ?2, 'generation', ?3, ?4, ?5, ?6, ?7, '[]', ?8)",
        params![shot_id, record.id, input.prompt.trim(), input.duration, input.resolution, input.visual_style_name, serde_json::to_string(&reference_names).unwrap_or_else(|_| "[]".to_owned()), now],
    ).map_err(|error| error.to_string())?;
    Ok(FreeCreationTask {
        id: shot_id,
        kind: "generation".to_owned(),
        prompt: input.prompt.trim().to_owned(),
        duration: input.duration,
        resolution: input.resolution,
        visual_style_name: input.visual_style_name,
        reference_names,
        source_record_ids: Vec::new(),
        record,
    })
}

#[tauri::command]
pub async fn list_free_creation_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<FreeCreationTask>, String> {
    crate::background::run("读取自由创作任务", move || {
        let (root, _) = workspace(&app)?;
        let connection = crate::database::open(&root)?;
        let records = crate::database::generation_records::list_for_project(&connection, PROJECT_ID)?;
        let by_id: HashMap<_, _> = records.into_iter().map(|record| (record.id.clone(), record)).collect();
        let mut statement = connection.prepare(
            "SELECT id, record_id, kind, prompt, duration, resolution, visual_style_name, reference_names_json, source_record_ids_json
             FROM free_creation_tasks ORDER BY created_at DESC"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?,
            row.get::<_, f64>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
        ))).map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (id, record_id, kind, prompt, duration, resolution, visual_style_name, references, sources) = row.map_err(|error| error.to_string())?;
            if let Some(record) = by_id.get(&record_id) {
                result.push(FreeCreationTask {
                    id, kind, prompt, duration, resolution, visual_style_name,
                    reference_names: serde_json::from_str(&references).unwrap_or_default(),
                    source_record_ids: serde_json::from_str(&sources).unwrap_or_default(),
                    record: record.clone(),
                });
            }
        }
        Ok(result)
    }).await
}

#[tauri::command]
pub fn compose_free_creation_videos(
    app: tauri::AppHandle,
    input: ComposeFreeCreationVideosInput,
) -> Result<FreeCreationTask, String> {
    let root = validate_workspace(&app, &input.workspace)?;
    if input.ordered_record_ids.is_empty() || input.ordered_record_ids.len() > 200 {
        return Err("请选择 1 到 200 个已完成的视频".to_owned());
    }
    let connection = crate::database::open(&root)?;
    let records = crate::database::generation_records::list_for_project(&connection, PROJECT_ID)?;
    let mut shot_ids = Vec::new();
    let mut aspect_ratio = None;
    let mut duration = 0.0;
    let mut resolution = String::new();
    for record_id in &input.ordered_record_ids {
        let record = records
            .iter()
            .find(|record| {
                &record.id == record_id
                    && record.target_type == "shot"
                    && record.status == crate::database::generation_records::STATUS_COMPLETED
            })
            .ok_or_else(|| "选中的视频已不可用，请刷新后重选".to_owned())?;
        shot_ids.push(record.target_id.clone());
        aspect_ratio.get_or_insert_with(|| record.aspect_ratio.clone());
        let details = connection.query_row(
            "SELECT duration, resolution FROM free_creation_tasks WHERE record_id = ?1 AND kind = 'generation'",
            [record_id],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?)),
        ).map_err(|error| error.to_string())?;
        duration += details.0;
        if resolution.is_empty() {
            resolution = details.1;
        }
    }
    drop(connection);
    let record = crate::ai::compose_project_video(
        app,
        crate::ai::ComposeProjectVideoInput {
            project_path: input.workspace.project_path,
            project_id: PROJECT_ID.to_owned(),
            ordered_shot_ids: shot_ids,
            aspect_ratio: aspect_ratio.unwrap_or_else(|| "9:16".to_owned()),
        },
    )?;
    let id = format!("COMPOSE_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let prompt = format!("合成 {} 个自由创作视频", input.ordered_record_ids.len());
    let connection = crate::database::open(&root)?;
    connection.execute(
        "INSERT INTO free_creation_tasks(id, record_id, kind, prompt, duration, resolution, visual_style_name, reference_names_json, source_record_ids_json, created_at)
         VALUES (?1, ?2, 'composition', ?3, ?4, ?5, '', '[]', ?6, ?7)",
        params![id, record.id, prompt, duration, resolution, serde_json::to_string(&input.ordered_record_ids).unwrap_or_else(|_| "[]".to_owned()), now],
    ).map_err(|error| error.to_string())?;
    Ok(FreeCreationTask {
        id,
        kind: "composition".to_owned(),
        prompt,
        duration,
        resolution,
        visual_style_name: String::new(),
        reference_names: Vec::new(),
        source_record_ids: input.ordered_record_ids,
        record,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_reopenable_internal_workspace() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-free-creation")
            .join(uuid::Uuid::new_v4().simple().to_string());
        fs::create_dir_all(&root).unwrap();
        create_workspace_files(&root).unwrap();
        create_workspace_files(&root).unwrap();

        assert!(root.join("project.json").is_file());
        assert!(root.join("generated/videos").is_dir());
        let connection = crate::database::open(&root).unwrap();
        let project_id: String = connection
            .query_row("SELECT id FROM projects", [], |row| row.get(0))
            .unwrap();
        let task_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='free_creation_tasks')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_id, PROJECT_ID);
        assert!(task_table_exists);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
