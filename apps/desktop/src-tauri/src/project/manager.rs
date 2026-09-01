use chrono::Utc;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::database;

#[derive(Debug, Deserialize)]
pub struct CreateProjectInput {
    pub root_path: String,
    pub source_type: String,
    pub source_text: Option<String>,
    pub source_path: Option<String>,
    pub creation_spec: Value,
}

pub fn create(input: CreateProjectInput) -> Result<Value, String> {
    let name = input
        .creation_spec
        .get("project_name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled Project")
        .trim();
    if name.is_empty() {
        return Err("project name is required".into());
    }
    let source_type = input.source_type.as_str();
    if !matches!(source_type, "IDEA" | "SCRIPT_TEXT" | "SCRIPT_FILE") {
        return Err(format!("unsupported source type: {source_type}"));
    }
    let source_text = input.source_text.as_deref().unwrap_or("").trim();
    if matches!(source_type, "IDEA") && source_text.chars().count() < 4 {
        return Err("idea must contain at least 4 characters".into());
    }
    if source_type == "IDEA" {
        let target_duration = input
            .creation_spec
            .get("target_duration")
            .and_then(Value::as_f64)
            .ok_or_else(|| "创作时长必须是有效的秒数".to_owned())?;
        if !(10.0..=3600.0).contains(&target_duration) {
            return Err("一句话创意的创作时长必须在 10～3600 秒之间".into());
        }
    }
    if matches!(source_type, "SCRIPT_TEXT") && source_text.chars().count() < 10 {
        return Err("script must contain at least 10 characters".into());
    }
    let original_source = if source_type == "SCRIPT_FILE" {
        let path = PathBuf::from(input.source_path.as_deref().unwrap_or(""));
        if !path.is_file() {
            return Err("selected script file does not exist".into());
        }
        Some(path)
    } else {
        None
    };
    let root = if input.root_path.trim().is_empty() {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join("projects")
    } else {
        PathBuf::from(input.root_path.trim())
    };
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let slug: String = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let project_id = format!("P_{}", uuid::Uuid::new_v4().simple());
    let project_path = root.join(format!("{}_{}", slug, &project_id[2..10]));
    create_directories(&project_path)?;
    let stored_source_path = if let Some(source) = original_source {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("txt")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "txt" | "md" | "docx" | "pdf") {
            return Err(format!("unsupported script extension: .{extension}"));
        }
        let relative = format!("source/original.{extension}");
        fs::copy(&source, project_path.join(&relative))
            .map_err(|error| format!("failed to copy script into project: {error}"))?;
        Some(relative)
    } else {
        None
    };
    let now = Utc::now().to_rfc3339();
    let connection = database::open(&project_path)?;
    let input_type = if source_type == "IDEA" {
        "IDEA"
    } else {
        "SCRIPT"
    };
    connection.execute(
        "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'DRAFT', ?5, ?5)",
        params![project_id, name, project_path.to_string_lossy(), input_type, now],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO project_sources(id, project_id, source_type, source_path, source_text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![uuid::Uuid::new_v4().to_string(), project_id, source_type, stored_source_path, source_text, now],
    ).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO creation_specs(project_id, data_json, updated_at) VALUES (?1, ?2, ?3)",
            params![project_id, input.creation_spec.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    let manifest = json!({"schema_version": 1, "project_id": project_id, "user_id": crate::platform_session::current_user_id()?, "name": name, "database": "project.db", "source_type": source_type, "created_at": now});
    fs::write(
        project_path.join("project.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    crate::database::repository::load_bundle(&connection)
}

fn create_directories(project_path: &Path) -> Result<(), String> {
    let directories = [
        "source",
        "derived/audio",
        "derived/frames",
        "derived/shots",
        "derived/proxy",
        "derived/transcripts",
        "characters",
        "scenes",
        "storyboard",
        "generated/images",
        "generated/videos",
        "generated/audio",
        "generated/subtitles",
        "timeline",
        "exports",
        "cache",
        "temp",
        "logs",
    ];
    for relative in directories {
        fs::create_dir_all(project_path.join(relative)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_reopenable_script_project_on_disk() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-projects")
            .join(uuid::Uuid::new_v4().simple().to_string());
        let bundle = create(CreateProjectInput {
            root_path: test_root.to_string_lossy().to_string(),
            source_type: "SCRIPT_TEXT".to_owned(),
            source_text: Some("第一场 外景 街道\n林小凡：这是一个真实剧本项目。".to_owned()),
            source_path: None,
            creation_spec: json!({
                "project_name": "剧本持久化测试",
                "input_type": "SCRIPT",
                "target_duration": 60,
                "aspect_ratio": "9:16",
                "content_type": "SHORT_DRAMA",
                "visual_style": "ANIME_CINEMATIC",
                "target_platform": "LOCAL",
                "language": "zh-CN",
                "creation_mode": "DIRECTOR"
            }),
        })
        .expect("project should be created");
        let project_path = PathBuf::from(bundle["project"]["project_path"].as_str().unwrap());
        assert!(project_path.join("project.json").is_file());
        assert!(project_path.join("project.db").is_file());
        let connection = database::open(&project_path).unwrap();
        let reopened = crate::database::repository::load_bundle(&connection).unwrap();
        assert_eq!(reopened["source_type"], "SCRIPT_TEXT");
        assert!(reopened["source_text"]
            .as_str()
            .unwrap()
            .contains("真实剧本"));
        drop(connection);
        fs::remove_dir_all(&test_root).expect("test project cleanup should succeed");
    }
}
