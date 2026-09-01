use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

const SERVICE: &str = "AI Video Studio Platform Session";
const USER: &str = "default";
static USER_CONTEXT_INITIALIZING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformSession {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_at: String,
    #[serde(default)]
    pub(crate) user_id: Option<String>,
}

fn credential() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|error| format!("无法访问系统凭据管理器：{error}"))
}

fn validate(session: &PlatformSession) -> Result<(), String> {
    if session.access_token.trim().is_empty()
        || session.refresh_token.trim().is_empty()
        || session.expires_at.trim().is_empty()
        || session.access_token.len() > 16_384
        || session.refresh_token.len() > 1_024
    {
        return Err("平台登录会话内容无效".into());
    }
    if session.user_id.as_deref().is_some_and(|value| {
        value.is_empty()
            || value.len() > 64
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    }) {
        return Err("平台用户标识无效".into());
    }
    Ok(())
}

#[cfg(not(test))]
pub fn current_user_id() -> Result<String, String> {
    read_platform_session()?
        .and_then(|session| session.user_id)
        .ok_or_else(|| "请先登录平台账户；旧版登录会话需要重新登录一次".to_owned())
}

#[cfg(test)]
pub fn current_user_id() -> Result<String, String> {
    Ok("test-user".to_owned())
}

pub fn user_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let user_id = current_user_id()?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("users")
        .join(user_id);
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn valid_legacy_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

pub fn user_scoped_file(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if !valid_legacy_name(name) {
        return Err("用户数据文件名称无效".to_owned());
    }
    let target = user_data_dir(app)?.join(name);
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(name);
    if !target.exists() && legacy.is_file() {
        std::fs::rename(&legacy, &target)
            .map_err(|error| format!("迁移旧版用户数据 {name} 失败：{error}"))?;
    }
    Ok(target)
}

pub fn user_scoped_sqlite(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    let target = user_scoped_file(app, name)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = format!("{name}{suffix}");
        user_scoped_file(app, &sidecar)?;
    }
    Ok(target)
}

pub fn user_scoped_directory(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    if !valid_legacy_name(name) {
        return Err("用户数据目录名称无效".to_owned());
    }
    let target = user_data_dir(app)?.join(name);
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(name);
    if !target.exists() && legacy.is_dir() {
        std::fs::rename(&legacy, &target)
            .map_err(|error| format!("迁移旧版用户数据目录 {name} 失败：{error}"))?;
    }
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    Ok(target)
}

pub fn bind_local_database_owner(connection: &rusqlite::Connection) -> Result<String, String> {
    let user_id = current_user_id()?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_data_owner (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                user_id TEXT NOT NULL,
                bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO local_data_owner(singleton, user_id) VALUES (1, ?1)",
            [&user_id],
        )
        .map_err(|error| error.to_string())?;
    let owner: String = connection
        .query_row(
            "SELECT user_id FROM local_data_owner WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if owner != user_id {
        return Err("本地数据属于其他平台账户，当前用户无权访问".to_owned());
    }
    Ok(user_id)
}

pub fn bind_user_owned_tables(
    connection: &rusqlite::Connection,
    tables: &[&str],
) -> Result<(), String> {
    let user_id = bind_local_database_owner(connection)?;
    for table in tables {
        if table.is_empty()
            || !table
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err("本地用户数据表名称无效".to_owned());
        }
        let has_user_id: bool = connection
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = 'user_id')"),
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_user_id {
            connection
                .execute(
                    &format!("ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"),
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        connection
            .execute(
                &format!("UPDATE {table} SET user_id = ?1 WHERE user_id = ''"),
                [&user_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(&format!(
                "DROP TRIGGER IF EXISTS set_{table}_user_id;
                 CREATE TRIGGER set_{table}_user_id AFTER INSERT ON {table} WHEN NEW.user_id = '' BEGIN
                   UPDATE {table} SET user_id = '{user_id}' WHERE rowid = NEW.rowid;
                 END;"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn activate_user_context(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(current_user_id)
        .await
        .map_err(|error| format!("读取用户身份线程失败：{error}"))??;
    if USER_CONTEXT_INITIALIZING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    if let Err(error) = std::thread::Builder::new()
        .name("aivs-user-context-init".to_owned())
        .spawn(move || {
            let result = (|| -> Result<(), String> {
                let projects = crate::project::registry::list(&app)?;
                let projects =
                    serde_json::from_value::<Vec<crate::project::registry::ProjectRecord>>(
                        projects,
                    )
                    .map_err(|error| format!("读取用户项目索引失败：{error}"))?;
                crate::database::asset_library::list(&app)?;
                crate::database::asset_library::sync_registered_projects(&app)?;
                for project in projects {
                    let project_root = std::path::PathBuf::from(project.project_path);
                    if let Err(error) = crate::ai::resume_project_image_tasks(&app, &project_root) {
                        eprintln!("恢复项目图片任务失败（{}）：{error}", project.id);
                    }
                    if let Err(error) = crate::ai::resume_project_video_tasks(&project_root) {
                        eprintln!("恢复项目视频任务失败（{}）：{error}", project.id);
                    }
                }
                crate::douyin_tasks::initialize(&app)?;
                crate::video_remix::initialize(&app)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("用户数据后台初始化失败：{error}");
            }
            USER_CONTEXT_INITIALIZING.store(false, Ordering::Release);
        })
    {
        USER_CONTEXT_INITIALIZING.store(false, Ordering::Release);
        return Err(format!("无法启动用户数据初始化线程：{error}"));
    }
    Ok(())
}

pub(crate) fn read_platform_session() -> Result<Option<PlatformSession>, String> {
    match credential()?.get_password() {
        Ok(value) => {
            let session = serde_json::from_str::<PlatformSession>(&value)
                .map_err(|_| "系统凭据中的平台登录会话已损坏".to_string())?;
            validate(&session)?;
            Ok(Some(session))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取平台登录会话失败：{error}")),
    }
}

pub(crate) fn write_platform_session(session: PlatformSession) -> Result<(), String> {
    validate(&session)?;
    let value = serde_json::to_string(&session)
        .map_err(|error| format!("序列化平台登录会话失败：{error}"))?;
    credential()?
        .set_password(&value)
        .map_err(|error| format!("保存平台登录会话失败：{error}"))
}

fn delete_platform_session() -> Result<(), String> {
    match credential()?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("清除平台登录会话失败：{error}")),
    }
}

#[tauri::command]
pub async fn get_platform_session() -> Result<Option<PlatformSession>, String> {
    tauri::async_runtime::spawn_blocking(read_platform_session)
        .await
        .map_err(|error| format!("读取登录会话线程失败：{error}"))?
}

#[tauri::command]
pub async fn save_platform_session(session: PlatformSession) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_platform_session(session))
        .await
        .map_err(|error| format!("保存登录会话线程失败：{error}"))?
}

#[tauri::command]
pub async fn clear_platform_session() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(delete_platform_session)
        .await
        .map_err(|error| format!("清除登录会话线程失败：{error}"))?
}
