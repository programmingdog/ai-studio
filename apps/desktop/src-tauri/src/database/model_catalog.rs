use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelCatalogItem {
    pub model: String,
    pub alias: String,
    pub capability: String,
    pub protocol: String,
    pub recommended: bool,
    pub sort_order: i64,
}

const DEFAULT_MODELS: &[(&str, &str, &str, &str, bool, i64)] = &[
    ("gpt-5.6-sol", "GPT-5.6 Sol", "agent", "openai", true, 10),
    ("gemini-3.7-flash", "盘古-3", "video", "gemini", false, 10),
    ("gpt-image-2", "刑天-2", "image", "openai", true, 10),
    (
        "gemini-3-pro-image-preview",
        "蚩尤-Pro",
        "image",
        "gemini",
        false,
        20,
    ),
    ("mj_imagine", "白泽-Pro", "image", "media", false, 30),
    (
        "doubao-seedream-5-0-pro-260628",
        "伏羲5.0-Pro",
        "image",
        "media",
        false,
        40,
    ),
    (
        "hailuo-h3-cankaosheng",
        "海螺MiniMax-H3",
        "video_generation",
        "media",
        false,
        10,
    ),
    (
        "kwvideo-v2-ref",
        "Seedance2.0",
        "video_generation",
        "media",
        false,
        20,
    ),
    (
        "omni_flash-10s",
        "白起-Flash",
        "video_generation",
        "media",
        false,
        30,
    ),
];

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("system-settings.db"))
        .map_err(|error| error.to_string())
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    migrate_and_seed(&connection)?;
    Ok(connection)
}

fn migrate_and_seed(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_model_catalog (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                alias TEXT NOT NULL,
                capability TEXT NOT NULL,
                protocol TEXT NOT NULL,
                recommended INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                UNIQUE(capability, model)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_model_catalog_capability
                ON ai_model_catalog(capability, enabled, sort_order);",
        )
        .map_err(|error| error.to_string())?;
    for (model, alias, capability, protocol, recommended, sort_order) in DEFAULT_MODELS {
        let id = format!("{capability}:{model}");
        connection
            .execute(
                "INSERT INTO ai_model_catalog(
                    id, model, alias, capability, protocol, recommended, sort_order, enabled
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
                 ON CONFLICT(id) DO UPDATE SET
                    model = excluded.model, alias = excluded.alias,
                    capability = excluded.capability, protocol = excluded.protocol,
                    recommended = excluded.recommended, sort_order = excluded.sort_order,
                    enabled = 1",
                params![
                    id,
                    model,
                    alias,
                    capability,
                    protocol,
                    recommended,
                    sort_order
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<AiModelCatalogItem>, String> {
    let connection = open(app)?;
    let mut statement = connection
        .prepare(
            "SELECT model, alias, capability, protocol, recommended, sort_order
             FROM ai_model_catalog WHERE enabled = 1
             ORDER BY capability DESC, sort_order, alias",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(AiModelCatalogItem {
                model: row.get(0)?,
                alias: row.get(1)?,
                capability: row.get(2)?,
                protocol: row.get(3)?,
                recommended: row.get(4)?,
                sort_order: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_alias_protocol_and_recommendation_mappings() {
        let connection = Connection::open_in_memory().unwrap();
        migrate_and_seed(&connection).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_model_catalog", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 9);
        let agent_mapping: (String, String) = connection
            .query_row(
                "SELECT alias, protocol FROM ai_model_catalog WHERE model = 'gpt-5.6-sol'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(agent_mapping, ("GPT-5.6 Sol".into(), "openai".into()));
        let mapping: (String, String, bool) = connection
            .query_row(
                "SELECT alias, protocol, recommended FROM ai_model_catalog WHERE model = 'gpt-image-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(mapping, ("刑天-2".into(), "openai".into(), true));

        let video_models: Vec<(String, String, String)> = connection
            .prepare(
                "SELECT model, alias, protocol FROM ai_model_catalog
                 WHERE capability = 'video_generation' ORDER BY sort_order",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            video_models,
            vec![
                (
                    "hailuo-h3-cankaosheng".into(),
                    "海螺MiniMax-H3".into(),
                    "media".into(),
                ),
                (
                    "kwvideo-v2-ref".into(),
                    "Seedance2.0".into(),
                    "media".into(),
                ),
                ("omni_flash-10s".into(), "白起-Flash".into(), "media".into(),),
            ]
        );
    }
}
