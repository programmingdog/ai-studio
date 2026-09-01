use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use super::manager::{self, CreateProjectInput};
use crate::{
    database, jobs,
    worker::python::{self, WorkerEvent},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectRecord {
    #[serde(default)]
    pub user_id: String,
    pub id: String,
    pub name: String,
    pub project_path: String,
    pub input_type: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub is_example: bool,
}

pub fn list(app: &AppHandle) -> Result<Value, String> {
    let user_id = crate::platform_session::current_user_id()?;
    let mut records = read_registry(app)?;
    if records.is_empty() {
        discover_default_projects(&mut records)?;
    }
    records.retain(|record| {
        record.user_id == user_id && is_valid_project(Path::new(&record.project_path))
    });
    ensure_example(app, &mut records)?;
    records.sort_by(|left, right| {
        right
            .is_example
            .cmp(&left.is_example)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    write_registry(app, &records)?;
    serde_json::to_value(records).map_err(|error| error.to_string())
}

pub fn register(app: &AppHandle, bundle: &Value, is_example: bool) -> Result<(), String> {
    let mut records = read_registry(app)?;
    upsert(&mut records, record_from_bundle(bundle, is_example)?);
    write_registry(app, &records)
}

pub fn find(app: &AppHandle, project_id: &str) -> Result<Option<ProjectRecord>, String> {
    let user_id = crate::platform_session::current_user_id()?;
    Ok(read_registry(app)?
        .into_iter()
        .find(|record| record.id == project_id && record.user_id == user_id))
}

pub fn unregister(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let mut records = read_registry(app)?;
    records.retain(|record| record.id != project_id);
    write_registry(app, &records)
}

fn ensure_example(app: &AppHandle, records: &mut Vec<ProjectRecord>) -> Result<(), String> {
    if records
        .iter()
        .any(|record| record.is_example && is_valid_project(Path::new(&record.project_path)))
    {
        return Ok(());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("examples");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let idea = "一个外卖员获得孙悟空能力，每天只能变身一个小时。";
    let creation_spec = json!({
        "project_name": "示例项目：齐天一小时",
        "input_type": "IDEA",
        "target_duration": 60,
        "aspect_ratio": "9:16",
        "content_type": "SHORT_DRAMA",
        "visual_style": "ANIME_CINEMATIC",
        "target_platform": "WECHAT_VIDEO_CHANNEL",
        "language": "zh-CN",
        "creation_mode": "DIRECTOR"
    });
    let bundle = manager::create(CreateProjectInput {
        root_path: root.to_string_lossy().to_string(),
        source_type: "IDEA".to_owned(),
        source_text: Some(idea.to_owned()),
        source_path: None,
        creation_spec: creation_spec.clone(),
    })?;
    let project_path = PathBuf::from(
        bundle["project"]["project_path"]
            .as_str()
            .ok_or("example project path missing")?,
    );
    let project_id = bundle["project"]["id"]
        .as_str()
        .ok_or("example project id missing")?;
    let mut connection = database::open(&project_path)?;
    let job_id = jobs::create(
        &connection,
        project_id,
        "DEVELOP_IDEA",
        &json!({"built_in_example": true}),
    )?;
    jobs::update(
        &connection,
        &job_id,
        "RUNNING",
        0.05,
        Some("example_setup"),
        Some("正在创建内置示例项目"),
    )?;
    let mut canonical = None;
    for event in python::develop_idea(idea, &creation_spec)? {
        match event {
            WorkerEvent::Progress {
                value,
                stage,
                message,
            } => {
                jobs::update(
                    &connection,
                    &job_id,
                    "RUNNING",
                    value,
                    Some(&stage),
                    Some(&message),
                )?;
            }
            WorkerEvent::Result(data) => canonical = Some(data),
            WorkerEvent::Error(error) => {
                return Err(format!("failed to create example project: {error}"))
            }
        }
    }
    database::repository::save_canonical(
        &mut connection,
        project_id,
        &canonical.ok_or("example workflow returned no result")?,
    )?;
    jobs::update(
        &connection,
        &job_id,
        "COMPLETED",
        1.0,
        Some("completed"),
        Some("示例项目已就绪"),
    )?;
    let completed = database::repository::load_bundle(&connection)?;
    upsert(records, record_from_bundle(&completed, true)?);
    Ok(())
}

fn discover_default_projects(records: &mut Vec<ProjectRecord>) -> Result<(), String> {
    let default_root = PathBuf::from(r"C:\AI Video Studio Projects");
    if !default_root.is_dir() {
        return Ok(());
    }
    for item in fs::read_dir(default_root).map_err(|error| error.to_string())? {
        let path = item.map_err(|error| error.to_string())?.path();
        if !is_valid_project(&path) {
            continue;
        }
        if let Ok(connection) = database::open(&path) {
            if let Ok(bundle) = database::repository::load_bundle(&connection) {
                if let Ok(record) = record_from_bundle(&bundle, false) {
                    upsert(records, record);
                }
            }
        }
    }
    Ok(())
}

fn record_from_bundle(bundle: &Value, is_example: bool) -> Result<ProjectRecord, String> {
    let project = bundle.get("project").ok_or("bundle.project missing")?;
    let value = |key: &str| {
        project
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("project.{key} missing"))
    };
    Ok(ProjectRecord {
        user_id: crate::platform_session::current_user_id()?,
        id: value("id")?,
        name: value("name")?,
        project_path: value("project_path")?,
        input_type: value("input_type")?,
        status: value("status")?,
        created_at: value("created_at")?,
        updated_at: value("updated_at")?,
        is_example,
    })
}

fn upsert(records: &mut Vec<ProjectRecord>, mut incoming: ProjectRecord) {
    if let Some(existing) = records
        .iter_mut()
        .find(|record| record.id == incoming.id || record.project_path == incoming.project_path)
    {
        incoming.is_example |= existing.is_example;
        *existing = incoming;
    } else {
        records.push(incoming);
    }
}

fn is_valid_project(path: &Path) -> bool {
    path.join("project.json").is_file() && path.join("project.db").is_file()
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::platform_session::user_scoped_file(app, "projects.json")
}

fn read_registry(app: &AppHandle) -> Result<Vec<ProjectRecord>, String> {
    let path = registry_path(app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut records: Vec<ProjectRecord> = serde_json::from_str(&content)
        .map_err(|error| format!("invalid project registry: {error}"))?;
    let user_id = crate::platform_session::current_user_id()?;
    for record in records
        .iter_mut()
        .filter(|record| record.user_id.is_empty())
    {
        if database::open(Path::new(&record.project_path)).is_ok() {
            record.user_id = user_id.clone();
        }
    }
    Ok(records)
}

fn write_registry(app: &AppHandle, records: &[ProjectRecord]) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(records).map_err(|error| error.to_string())?;
    fs::write(registry_path(app)?, content).map_err(|error| error.to_string())
}
