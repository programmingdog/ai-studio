use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize)]
pub struct AssetLibraryItem {
    pub id: String,
    pub asset_type: String,
    pub name: String,
    pub prompt: String,
    pub image_path: String,
    pub source_project_id: Option<String>,
    pub source_project_path: Option<String>,
    pub source_target_type: Option<String>,
    pub source_target_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeleteAssetLibraryResult {
    pub deleted_count: usize,
    pub deleted_ids: Vec<String>,
}

fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::platform_session::user_scoped_directory(app, "asset-library")
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let connection = open_library(&library_root(app)?)?;
    crate::platform_session::bind_user_owned_tables(
        &connection,
        &["asset_library", "asset_library_deletions"],
    )?;
    Ok(connection)
}

fn open_library(root: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        root.join("asset-library.db"),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| format!("打开资产库数据库失败：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
        CREATE TABLE IF NOT EXISTS asset_library (
            id TEXT PRIMARY KEY,
            asset_type TEXT NOT NULL CHECK(asset_type IN ('scene', 'character', 'prop')),
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            image_path TEXT NOT NULL,
            source_key TEXT NOT NULL UNIQUE,
            source_project_id TEXT,
            source_project_path TEXT,
            source_target_type TEXT,
            source_target_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_library_type_created
            ON asset_library(asset_type, created_at DESC);
        CREATE TABLE IF NOT EXISTS asset_library_deletions (
            source_key TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL
        );
        "#,
        )
        .map_err(|error| format!("初始化资产库数据库失败：{error}"))
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetLibraryItem> {
    Ok(AssetLibraryItem {
        id: row.get(0)?,
        asset_type: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        image_path: row.get(4)?,
        source_project_id: row.get(5)?,
        source_project_path: row.get(6)?,
        source_target_type: row.get(7)?,
        source_target_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn list(app: &AppHandle) -> Result<Vec<AssetLibraryItem>, String> {
    let connection = open(app)?;
    let mut statement = connection.prepare(
        "SELECT id, asset_type, name, prompt, image_path, source_project_id,
                source_project_path, source_target_type, source_target_id, created_at, updated_at
         FROM asset_library ORDER BY CASE asset_type WHEN 'scene' THEN 1 WHEN 'character' THEN 2 ELSE 3 END, created_at DESC",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_item)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn target_details(
    project_root: &Path,
    target_type: &str,
    target_id: &str,
) -> Result<(String, String), String> {
    let connection = super::open(project_root)?;
    let project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|error| format!("读取资产来源项目失败：{error}"))?;
    let name = match target_type {
        "scene" => connection
            .query_row(
                "SELECT name FROM scenes WHERE id = ?1",
                [target_id],
                |row| row.get(0),
            )
            .optional(),
        "character" => connection
            .query_row(
                "SELECT name FROM characters WHERE id = ?1",
                [target_id],
                |row| row.get(0),
            )
            .optional(),
        "character_state" => connection
            .query_row(
                "SELECT characters.name || ' · ' || character_states.name
             FROM character_states JOIN characters ON characters.id = character_states.character_id
             WHERE character_states.id = ?1",
                [target_id],
                |row| row.get(0),
            )
            .optional(),
        "prop" => Ok(Some(target_id.to_owned())),
        _ => return Err(format!("不支持写入资产库的类型：{target_type}")),
    }
    .map_err(|error| format!("读取资产名称失败：{error}"))?
    .unwrap_or_else(|| target_id.to_owned());
    Ok((project_id, name))
}

fn target_prompt(
    project_root: &Path,
    target_type: &str,
    target_id: &str,
) -> Result<String, String> {
    let connection = super::open(project_root)?;
    let query = match target_type {
        "scene" => "SELECT data_json FROM scenes WHERE id = ?1",
        "character" => "SELECT data_json FROM characters WHERE id = ?1",
        "character_state" => "SELECT data_json FROM character_states WHERE id = ?1",
        _ => return Ok(String::new()),
    };
    let data = connection
        .query_row(query, [target_id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| format!("读取既有资产描述失败：{error}"))?;
    let Some(data) = data else {
        return Ok("从既有项目导入的生成资产".to_owned());
    };
    let value: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
    let fields: &[&str] = match target_type {
        "scene" => &["description", "lighting", "layout", "mood"],
        "character" => &["appearance_lock", "clothing_lock", "role"],
        "character_state" => &["description", "appearance_lock", "clothing_lock"],
        _ => &[],
    };
    let prompt = fields
        .iter()
        .filter_map(|field| value.get(field).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("；");
    Ok(if prompt.is_empty() {
        "从既有项目导入的生成资产".to_owned()
    } else {
        prompt
    })
}

fn collect_image_files(directory: &Path, images: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_image_files(&path, images)?;
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp"
                )
            })
        {
            images.push(path);
        }
    }
    Ok(())
}

fn legacy_target(path: &Path, target_type: &str) -> Option<(String, String)> {
    let stem = path.file_stem()?.to_str()?;
    let target_id = stem
        .rsplit_once('_')
        .filter(|(_, suffix)| {
            suffix.len() >= 10 && suffix.chars().all(|value| value.is_ascii_digit())
        })
        .map(|(prefix, _)| prefix)
        .unwrap_or(stem)
        .to_owned();
    let resolved_type = if target_type == "character" && target_id.contains("_STATE_") {
        "character_state"
    } else {
        target_type
    };
    Some((resolved_type.to_owned(), target_id))
}

fn restore_moved_files(moved_files: &[(PathBuf, PathBuf)]) {
    for (source, destination) in moved_files.iter().rev() {
        let _ = fs::rename(destination, source);
    }
}

pub fn store_generated(
    app: &AppHandle,
    project_root: &Path,
    source_key: &str,
    target_type: &str,
    target_id: &str,
    prompt: &str,
    source_path: &Path,
) -> Result<Option<AssetLibraryItem>, String> {
    let asset_type = match target_type {
        "scene" => "scene",
        "character" | "character_state" => "character",
        "prop" => "prop",
        _ => return Ok(None),
    };
    if !source_path.is_file() {
        return Err(format!("资产图片不存在：{}", source_path.display()));
    }
    let connection = open(app)?;
    let was_deleted = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM asset_library_deletions WHERE source_key = ?1)",
            [source_key],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if was_deleted {
        return Ok(None);
    }
    let existing = connection
        .query_row(
            "SELECT id, asset_type, name, prompt, image_path, source_project_id,
                source_project_path, source_target_type, source_target_id, created_at, updated_at
         FROM asset_library WHERE source_key = ?1",
            [source_key],
            row_item,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.is_some() {
        return Ok(existing);
    }
    let (project_id, name) = target_details(project_root, target_type, target_id)?;
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("资产库仅支持 PNG、JPG/JPEG 或 WebP 图片".to_owned());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let destination_dir = library_root(app)?.join("images").join(asset_type);
    fs::create_dir_all(&destination_dir)
        .map_err(|error| format!("创建资产图片目录失败：{error}"))?;
    let destination = destination_dir.join(format!("{id}.{extension}"));
    fs::copy(source_path, &destination)
        .map_err(|error| format!("复制图片到资产库失败：{error}"))?;
    let now = Utc::now().to_rfc3339();
    if let Err(error) = connection.execute(
        "INSERT INTO asset_library(id, asset_type, name, prompt, image_path, source_key,
          source_project_id, source_project_path, source_target_type, source_target_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id, asset_type, name, prompt.trim(), destination.to_string_lossy(), source_key,
            project_id, project_root.to_string_lossy(), target_type, target_id, now,
        ],
    ) {
        let _ = fs::remove_file(&destination);
        return Err(format!("写入资产库记录失败：{error}"));
    }
    connection
        .query_row(
            "SELECT id, asset_type, name, prompt, image_path, source_project_id,
                source_project_path, source_target_type, source_target_id, created_at, updated_at
         FROM asset_library WHERE id = ?1",
            [&id],
            row_item,
        )
        .map(Some)
        .map_err(|error| error.to_string())
}

pub fn delete(app: &AppHandle, asset_ids: Vec<String>) -> Result<DeleteAssetLibraryResult, String> {
    delete_from_library(&library_root(app)?, asset_ids)
}

fn delete_from_library(
    library: &Path,
    asset_ids: Vec<String>,
) -> Result<DeleteAssetLibraryResult, String> {
    let mut unique_ids = asset_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    unique_ids.sort();
    if unique_ids.is_empty() {
        return Err("请至少选择一项需要删除的资产".to_owned());
    }
    if unique_ids.len() > 2_000 {
        return Err("单次最多删除 2000 项资产".to_owned());
    }

    let images_root = library.join("images");
    fs::create_dir_all(&images_root).map_err(|error| format!("读取资产图片目录失败：{error}"))?;
    let canonical_images_root =
        fs::canonicalize(&images_root).map_err(|error| format!("确认资产图片目录失败：{error}"))?;
    let mut connection = open_library(library)?;
    let mut records = Vec::new();
    for id in unique_ids {
        let record = connection
            .query_row(
                "SELECT id, source_key, image_path FROM asset_library WHERE id = ?1",
                [&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(record) = record {
            records.push(record);
        }
    }
    if records.is_empty() {
        return Ok(DeleteAssetLibraryResult {
            deleted_count: 0,
            deleted_ids: Vec::new(),
        });
    }

    let trash = library
        .join("delete-staging")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&trash).map_err(|error| format!("创建资产删除暂存目录失败：{error}"))?;
    let canonical_library =
        fs::canonicalize(&library).map_err(|error| format!("确认资产库目录失败：{error}"))?;
    let trash =
        fs::canonicalize(&trash).map_err(|error| format!("确认资产删除暂存目录失败：{error}"))?;
    if !trash.starts_with(&canonical_library) {
        return Err("资产删除暂存目录范围无效，已停止删除".to_owned());
    }
    let mut moved_files: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (id, _, image_path) in &records {
        let original = PathBuf::from(image_path);
        if !original.is_file() {
            continue;
        }
        let canonical = match fs::canonicalize(&original) {
            Ok(path) => path,
            Err(error) => {
                restore_moved_files(&moved_files);
                let _ = fs::remove_dir_all(&trash);
                return Err(format!("确认待删除资产图片失败：{error}"));
            }
        };
        if !canonical.starts_with(&canonical_images_root) {
            restore_moved_files(&moved_files);
            let _ = fs::remove_dir_all(&trash);
            return Err("检测到资产图片不在资产库目录内，已停止删除".to_owned());
        }
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("image");
        let staged = trash.join(format!("{id}.{extension}"));
        if let Err(error) = fs::rename(&canonical, &staged) {
            restore_moved_files(&moved_files);
            let _ = fs::remove_dir_all(&trash);
            return Err(format!("暂存待删除资产图片失败：{error}"));
        }
        moved_files.push((canonical, staged));
    }

    let now = Utc::now().to_rfc3339();
    let database_result = (|| -> Result<(), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for (id, source_key, _) in &records {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO asset_library_deletions(source_key, deleted_at) VALUES (?1, ?2)",
                    params![source_key, now],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute("DELETE FROM asset_library WHERE id = ?1", [id])
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = database_result {
        restore_moved_files(&moved_files);
        let _ = fs::remove_dir_all(&trash);
        return Err(format!("删除资产数据失败：{error}"));
    }
    if let Err(error) = fs::remove_dir_all(&trash) {
        eprintln!("清理已删除资产图片暂存目录失败：{error}");
    }
    let deleted_ids = records.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>();
    Ok(DeleteAssetLibraryResult {
        deleted_count: deleted_ids.len(),
        deleted_ids,
    })
}

pub fn sync_project_images(app: &AppHandle, project_root: &Path) -> Result<usize, String> {
    let connection = super::open(project_root)?;
    let project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|error| format!("读取资产来源项目失败：{error}"))?;
    let mut statement = connection.prepare(
        "SELECT id, project_id, target_type, target_id, prompt, result_relative_path, result_absolute_path
         FROM image_generation_tasks
         WHERE target_type IN ('scene', 'character', 'character_state')",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let records = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);
    let mut synced = 0;
    let mut task_paths = HashSet::new();
    for (task_id, project_id, target_type, target_id, prompt, relative_path, absolute_path) in
        records
    {
        let path = absolute_path
            .map(PathBuf::from)
            .filter(|value| value.is_file())
            .or_else(|| {
                relative_path
                    .map(|value| project_root.join(value))
                    .filter(|value| value.is_file())
            });
        let Some(path) = path else {
            continue;
        };
        task_paths.insert(fs::canonicalize(&path).unwrap_or_else(|_| path.clone()));
        let source_key = format!("task:{project_id}/{task_id}");
        if store_generated(
            app,
            project_root,
            &source_key,
            &target_type,
            &target_id,
            &prompt,
            &path,
        )?
        .is_some()
        {
            synced += 1;
        }
    }
    for (directory, target_type) in [
        (project_root.join("scenes"), "scene"),
        (project_root.join("characters"), "character"),
    ] {
        let mut images = Vec::new();
        collect_image_files(&directory, &mut images)?;
        for path in images {
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if task_paths.contains(&canonical) {
                continue;
            }
            let Some((resolved_type, target_id)) = legacy_target(&path, target_type) else {
                continue;
            };
            let relative = path.strip_prefix(project_root).unwrap_or(&path);
            let source_key = format!(
                "legacy:{project_id}/{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            let prompt = target_prompt(project_root, &resolved_type, &target_id)?;
            if store_generated(
                app,
                project_root,
                &source_key,
                &resolved_type,
                &target_id,
                &prompt,
                &path,
            )?
            .is_some()
            {
                synced += 1;
            }
        }
    }
    Ok(synced)
}

pub fn sync_registered_projects(app: &AppHandle) -> Result<usize, String> {
    let records: Vec<crate::project::registry::ProjectRecord> =
        serde_json::from_value(crate::project::registry::list(app)?)
            .map_err(|error| format!("读取项目列表失败：{error}"))?;
    let mut synced = 0;
    let mut failures = Vec::new();
    for record in records.into_iter().filter(|record| !record.is_example) {
        let project_root = PathBuf::from(&record.project_path);
        match sync_project_images(app, &project_root) {
            Ok(count) => synced += count,
            Err(error) => failures.push(format!("{}：{}", record.name, error)),
        }
    }
    if !failures.is_empty() {
        eprintln!("同步既有项目资产时有部分项目失败：{}", failures.join("；"));
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::{delete_from_library, legacy_target, migrate, open_library, Connection};
    use rusqlite::params;
    use std::{fs, path::Path};

    #[test]
    fn migration_creates_required_asset_fields() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let mut statement = connection
            .prepare("PRAGMA table_info(asset_library)")
            .unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for required in ["asset_type", "name", "prompt", "image_path"] {
            assert!(
                columns.iter().any(|column| column == required),
                "missing {required}"
            );
        }
        let deletion_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_library_deletions')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deletion_table_exists);
    }

    #[test]
    fn legacy_generated_file_names_restore_target_ids() {
        assert_eq!(
            legacy_target(Path::new("SCENE_001_1787894214298.png"), "scene"),
            Some(("scene".to_owned(), "SCENE_001".to_owned()))
        );
        assert_eq!(
            legacy_target(
                Path::new("CHAR_002_STATE_001_1787894179881.png"),
                "character"
            ),
            Some((
                "character_state".to_owned(),
                "CHAR_002_STATE_001".to_owned()
            ))
        );
    }

    #[test]
    fn batch_delete_removes_database_record_and_library_image() {
        let root =
            std::env::temp_dir().join(format!("aivs-asset-delete-test-{}", uuid::Uuid::new_v4()));
        let image_directory = root.join("images").join("scene");
        fs::create_dir_all(&image_directory).unwrap();
        let image = image_directory.join("asset-1.png");
        fs::write(&image, b"isolated-test-image").unwrap();
        let connection = open_library(&root).unwrap();
        connection.execute(
            "INSERT INTO asset_library(id, asset_type, name, prompt, image_path, source_key,
              source_project_id, source_project_path, source_target_type, source_target_id, created_at, updated_at)
             VALUES (?1, 'scene', '测试场景', '测试提示词', ?2, 'test:source-1',
              'P_TEST', 'C:/isolated-project', 'scene', 'SCENE_001', 'now', 'now')",
            params!["ASSET_1", image.to_string_lossy()],
        ).unwrap();
        drop(connection);

        let result = delete_from_library(&root, vec!["ASSET_1".to_owned()]).unwrap();
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.deleted_ids, vec!["ASSET_1"]);
        assert!(!image.exists());

        let connection = open_library(&root).unwrap();
        let asset_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM asset_library", [], |row| row.get(0))
            .unwrap();
        let deletion_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM asset_library_deletions WHERE source_key = 'test:source-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(asset_count, 0);
        assert_eq!(deletion_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
