use keyring::Entry;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicBool, Ordering}, OnceLock};
use tauri::Manager;

const SERVICE: &str = "AI Video Studio Platform Session";
const USER: &str = "default";
const REMEMBERED_CREDENTIALS_SERVICE: &str = "AI Video Studio Remembered Login Credentials";
const REMEMBERED_CREDENTIALS_USER: &str = "accounts";
const MAX_REMEMBERED_CREDENTIALS: usize = 10;
const SESSION_REFRESH_EARLY_SECONDS: i64 = 24 * 60 * 60;
static USER_CONTEXT_INITIALIZING: AtomicBool = AtomicBool::new(false);
static SESSION_REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformSession {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_at: String,
    #[serde(default)]
    pub(crate) user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RememberedCredential {
    account: String,
    password: String,
}

fn credential() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|error| format!("无法访问系统凭据管理器：{error}"))
}

fn remembered_credentials_entry() -> Result<Entry, String> {
    Entry::new(REMEMBERED_CREDENTIALS_SERVICE, REMEMBERED_CREDENTIALS_USER)
        .map_err(|error| format!("无法访问系统凭据管理器：{error}"))
}

fn validate_remembered_credential(account: &str, password: &str) -> Result<(), String> {
    if account.is_empty()
        || account.len() > 191
        || !account.contains('@')
        || account.chars().any(char::is_whitespace)
    {
        return Err("记住的登录账号无效".to_owned());
    }
    if password.len() < 8 || password.len() > 128 {
        return Err("记住的登录密码无效".to_owned());
    }
    Ok(())
}

fn read_remembered_credentials() -> Result<Vec<RememberedCredential>, String> {
    match remembered_credentials_entry()?.get_password() {
        Ok(value) => {
            let credentials = serde_json::from_str::<Vec<RememberedCredential>>(&value)
                .map_err(|_| "系统凭据中的已保存账号已损坏".to_owned())?;
            for credential in &credentials {
                validate_remembered_credential(&credential.account, &credential.password)?;
            }
            Ok(credentials)
        }
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(error) => Err(format!("读取已保存账号失败：{error}")),
    }
}

fn write_remembered_credentials(credentials: &[RememberedCredential]) -> Result<(), String> {
    if credentials.is_empty() {
        return match remembered_credentials_entry()?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("清除已保存账号失败：{error}")),
        };
    }
    let value = serde_json::to_string(credentials)
        .map_err(|error| format!("序列化已保存账号失败：{error}"))?;
    remembered_credentials_entry()?
        .set_password(&value)
        .map_err(|error| format!("保存登录账号失败：{error}"))
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

fn expires_soon(session: &PlatformSession) -> bool {
    chrono::DateTime::parse_from_rfc3339(&session.expires_at)
        .map(|expires_at| expires_at.timestamp() <= chrono::Utc::now().timestamp() + SESSION_REFRESH_EARLY_SECONDS)
        .unwrap_or(true)
}

fn refresh_error(status: StatusCode, body: &str) -> String {
    let value = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let message = value.get("message")
        .and_then(|message| message.as_str().map(str::to_owned).or_else(|| message.as_array().map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("；"))))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("刷新平台登录会话失败：HTTP {}", status.as_u16()));
    json!({
        "code": if status == StatusCode::UNAUTHORIZED { "PLATFORM_LOGIN_REQUIRED" } else { "PLATFORM_SESSION_REFRESH_FAILED" },
        "message": message,
        "retryable": status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
    }).to_string()
}

async fn refresh_locked(api_base: &str, rejected_access_token: &str, force: bool) -> Result<PlatformSession, String> {
    let api_base = crate::platform_media::refresh_api_base_url(api_base)?;
    let _guard = SESSION_REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let current = read_platform_session()?.ok_or_else(|| "请先登录平台账户".to_owned())?;
    // A concurrent browser/Rust request may already have rotated the one-time
    // refresh token. Always reuse that newer session instead of rotating again.
    if current.access_token != rejected_access_token || (!force && !expires_soon(&current)) {
        return Ok(current);
    }
    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法创建平台登录刷新客户端：{error}"))?
        .post(format!("{api_base}/auth/refresh"))
        .json(&json!({"refresh_token": current.refresh_token, "device_name": "AI Video Studio Desktop"}))
        .send()
        .await
        .map_err(|error| format!("无法连接平台登录刷新接口：{error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("读取平台登录刷新响应失败：{error}"))?;
    if !status.is_success() {
        if status == StatusCode::UNAUTHORIZED {
            let _ = delete_platform_session();
        }
        return Err(refresh_error(status, &body));
    }
    let value = serde_json::from_str::<Value>(&body).map_err(|error| format!("平台登录刷新响应格式无效：{error}"))?;
    let access_token = value.get("access_token").and_then(Value::as_str).unwrap_or("").to_owned();
    let refresh_token = value.get("refresh_token").and_then(Value::as_str).unwrap_or("").to_owned();
    let expires_in = value.get("expires_in").and_then(Value::as_i64).unwrap_or(0);
    if access_token.is_empty() || refresh_token.is_empty() || expires_in < 60 {
        return Err("平台登录刷新响应缺少有效令牌".to_owned());
    }
    let session = PlatformSession {
        access_token,
        refresh_token,
        expires_at: (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339(),
        user_id: value.pointer("/user/id").and_then(Value::as_str).map(str::to_owned).or(current.user_id),
    };
    write_platform_session(session.clone())?;
    Ok(session)
}

pub(crate) async fn valid_access_token(api_base: &str) -> Result<String, String> {
    let session = read_platform_session()?.ok_or_else(|| "请先登录平台账户".to_owned())?;
    if !expires_soon(&session) {
        return Ok(session.access_token);
    }
    let rejected = session.access_token.clone();
    Ok(refresh_locked(api_base, &rejected, false).await?.access_token)
}

pub(crate) async fn refresh_after_unauthorized(api_base: &str, rejected_access_token: &str) -> Result<String, String> {
    Ok(refresh_locked(api_base, rejected_access_token, true).await?.access_token)
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
                    if let Err(error) = crate::ai::resume_project_video_tasks(&app, &project_root) {
                        eprintln!("恢复项目视频任务失败（{}）：{error}", project.id);
                    }
                }
                crate::douyin_tasks::initialize(&app)?;
                crate::script_tasks::initialize(&app)?;
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
pub async fn refresh_platform_session(
    platform_api_base_url: String,
    rejected_access_token: String,
) -> Result<PlatformSession, String> {
    let base = crate::platform_media::api_base_url(&platform_api_base_url)?;
    refresh_locked(&base, &rejected_access_token, true).await
}

#[tauri::command]
pub async fn clear_platform_session() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(delete_platform_session)
        .await
        .map_err(|error| format!("清除登录会话线程失败：{error}"))?
}

#[tauri::command]
pub async fn get_remembered_credentials() -> Result<Vec<RememberedCredential>, String> {
    tauri::async_runtime::spawn_blocking(read_remembered_credentials)
        .await
        .map_err(|error| format!("读取已保存账号线程失败：{error}"))?
}

#[tauri::command]
pub async fn save_remembered_credential(
    account: String,
    password: String,
) -> Result<Vec<RememberedCredential>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = account.trim().to_lowercase();
        validate_remembered_credential(&account, &password)?;
        let mut credentials = read_remembered_credentials()?;
        credentials.retain(|credential| !credential.account.eq_ignore_ascii_case(&account));
        credentials.insert(0, RememberedCredential { account, password });
        credentials.truncate(MAX_REMEMBERED_CREDENTIALS);
        write_remembered_credentials(&credentials)?;
        Ok(credentials)
    })
    .await
    .map_err(|error| format!("保存登录账号线程失败：{error}"))?
}

#[tauri::command]
pub async fn delete_remembered_credential(
    account: String,
) -> Result<Vec<RememberedCredential>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = account.trim();
        let mut credentials = read_remembered_credentials()?;
        credentials.retain(|credential| !credential.account.eq_ignore_ascii_case(account));
        write_remembered_credentials(&credentials)?;
        Ok(credentials)
    })
    .await
    .map_err(|error| format!("删除已保存账号线程失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_at: chrono::DateTime<chrono::Utc>) -> PlatformSession {
        PlatformSession {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: expires_at.to_rfc3339(),
            user_id: Some("test-user".into()),
        }
    }

    #[test]
    fn refreshes_one_day_before_expiry_but_not_earlier() {
        assert!(expires_soon(&session(chrono::Utc::now() + chrono::Duration::hours(23))));
        assert!(!expires_soon(&session(chrono::Utc::now() + chrono::Duration::hours(25))));
    }
}
