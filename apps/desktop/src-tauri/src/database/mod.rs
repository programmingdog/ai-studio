pub mod asset_library;
pub mod automatic_workflows;
pub mod episodes;
pub mod generation_records;
pub mod idea_workflows;
pub mod image_tasks;
pub mod migrations;
pub mod model_catalog;
pub mod repository;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::Duration};

fn initialization_lock(project_path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let path = project_path.canonicalize().map_err(|e| e.to_string())?;
    let mut locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|e| e.to_string())?;
    Ok(locks.entry(path).or_insert_with(|| Arc::new(Mutex::new(()))).clone())
}

pub fn open(project_path: &Path) -> Result<Connection, String> {
    // Serialize only connection setup for this project. Running jobs retain
    // independent connections, while first-open WAL/schema setup cannot race.
    let lock = initialization_lock(project_path)?;
    let initialization = lock.lock().map_err(|e| e.to_string())?;
    let db_path = project_path.join("project.db");
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| error.to_string())?;
    let journal: String = connection.pragma_query_value(None, "journal_mode", |row| row.get(0)).map_err(|e| e.to_string())?;
    if !journal.eq_ignore_ascii_case("wal") {
        connection.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    migrations::migrate(&connection)?;
    drop(initialization);
    let user_id = crate::platform_session::current_user_id()?;
    let foreign_owner = connection
        .query_row(
            "SELECT user_id FROM projects WHERE user_id <> '' AND user_id <> ?1 LIMIT 1",
            [&user_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if foreign_owner.is_some() {
        return Err("该项目属于其他平台账户，当前用户无权访问".to_owned());
    }
    Ok(connection)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_a_project_owned_by_another_user() {
        let root = std::env::temp_dir().join(format!("aivs-owner-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let connection = super::open(&root).unwrap();
        connection.execute(
            "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
             VALUES ('P_FOREIGN', 'foreign', 'test', 'IDEA', 'DRAFT', 'now', 'now')",
            [],
        ).unwrap();
        connection
            .execute("UPDATE projects SET user_id = 'another-user'", [])
            .unwrap();
        drop(connection);
        let error = super::open(&root).unwrap_err();
        assert!(error.contains("其他平台账户"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
