use rusqlite::{Connection, Transaction, TransactionBehavior};

const CURRENT_VERSION: i64 = 8;

fn is_current(connection: &Connection) -> Result<bool, String> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !exists { return Ok(false); }
    connection.query_row("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?1)",
        [CURRENT_VERSION], |row| row.get(0)).map_err(|e| e.to_string())
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    // Normal reads must not rebuild triggers. Lock before inspecting/upgrading
    // the schema so other connections/processes cannot interleave DROP/CREATE.
    if is_current(connection)? { return Ok(()); }
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if !is_current(&transaction)? {
        migrate_schema(&transaction)?;
        if crate::platform_session::current_user_id().is_ok() {
            transaction.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
                [CURRENT_VERSION]).map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn migrate_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                input_type TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS project_sources (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_path TEXT,
                source_url TEXT,
                source_text TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS creation_specs (
                project_id TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS stories (
                project_id TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS story_beats (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                beat_order INTEGER NOT NULL,
                data_json TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT,
                data_json TEXT NOT NULL,
                locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS character_states (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                character_id TEXT NOT NULL,
                state_order INTEGER NOT NULL,
                name TEXT NOT NULL,
                data_json TEXT NOT NULL,
                locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
                UNIQUE(character_id, state_order)
            );
            CREATE INDEX IF NOT EXISTS idx_character_states_character
                ON character_states(project_id, character_id, state_order);
            CREATE TABLE IF NOT EXISTS scenes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                data_json TEXT NOT NULL,
                locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS sequences (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                sequence_order INTEGER NOT NULL,
                data_json TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS shots (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                sequence_id TEXT,
                scene_id TEXT,
                shot_order INTEGER NOT NULL,
                duration REAL NOT NULL,
                data_json TEXT NOT NULL,
                status TEXT NOT NULL,
                locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS shot_character_states (
                project_id TEXT NOT NULL,
                shot_id TEXT NOT NULL,
                character_id TEXT NOT NULL,
                state_id TEXT NOT NULL,
                PRIMARY KEY(shot_id, character_id),
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY(shot_id) REFERENCES shots(id) ON DELETE CASCADE,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
                FOREIGN KEY(state_id) REFERENCES character_states(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_shot_character_states_state
                ON shot_character_states(project_id, state_id, shot_id);
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                asset_type TEXT NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                status TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS image_generation_tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                protocol TEXT NOT NULL,
                prompt TEXT NOT NULL,
                aspect_ratio TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                remote_task_id TEXT,
                result_relative_path TEXT,
                result_absolute_path TEXT,
                result_mime_type TEXT,
                result_json TEXT,
                error_json TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_image_tasks_project
                ON image_generation_tasks(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_image_tasks_target
                ON image_generation_tasks(project_id, target_type, target_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_image_tasks_status
                ON image_generation_tasks(status, updated_at);
            CREATE TABLE IF NOT EXISTS generation_records (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                media_type TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                protocol TEXT NOT NULL,
                prompt TEXT NOT NULL,
                aspect_ratio TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                remote_task_id TEXT,
                result_relative_path TEXT,
                result_absolute_path TEXT,
                result_mime_type TEXT,
                result_json TEXT,
                error_json TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_generation_records_project
                ON generation_records(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_generation_records_target
                ON generation_records(project_id, media_type, target_type, target_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_generation_records_status
                ON generation_records(status, updated_at);
            CREATE TABLE IF NOT EXISTS automatic_workflows (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                resolution TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                retry_message TEXT,
                snapshot_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_automatic_workflows_active
                ON automatic_workflows(project_id, status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS idea_development_workflows (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                target_duration REAL NOT NULL,
                chunk_duration REAL NOT NULL,
                snapshot_json TEXT NOT NULL DEFAULT '{}',
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_idea_workflows_project
                ON idea_development_workflows(project_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                episode_order INTEGER NOT NULL,
                title TEXT NOT NULL,
                duration REAL NOT NULL,
                data_json TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_episodes_project
                ON episodes(project_id, episode_order);
            INSERT OR IGNORE INTO generation_records(
                id, project_id, media_type, target_type, target_id, base_url, model, protocol,
                prompt, aspect_ratio, status, progress, remote_task_id, result_relative_path,
                result_absolute_path, result_mime_type, result_json, error_json, retry_count,
                created_at, started_at, updated_at, finished_at
            ) SELECT id, project_id, 'image', target_type, target_id, base_url, model, protocol,
                prompt, aspect_ratio, status, progress, remote_task_id, result_relative_path,
                result_absolute_path, result_mime_type, result_json, error_json, retry_count,
                created_at, started_at, updated_at, finished_at FROM image_generation_tasks;
            DROP TRIGGER IF EXISTS sync_image_generation_insert;
            DROP TRIGGER IF EXISTS sync_image_generation_update;
            CREATE TRIGGER sync_image_generation_insert
            AFTER INSERT ON image_generation_tasks BEGIN
                INSERT OR REPLACE INTO generation_records(
                    id, project_id, media_type, target_type, target_id, base_url, model, protocol,
                    prompt, aspect_ratio, status, progress, remote_task_id, result_relative_path,
                    result_absolute_path, result_mime_type, result_json, error_json, retry_count,
                    created_at, started_at, updated_at, finished_at
                ) VALUES (NEW.id, NEW.project_id, 'image', NEW.target_type, NEW.target_id,
                    NEW.base_url, NEW.model, NEW.protocol, NEW.prompt, NEW.aspect_ratio,
                    NEW.status, NEW.progress, NEW.remote_task_id, NEW.result_relative_path,
                    NEW.result_absolute_path, NEW.result_mime_type, NEW.result_json, NEW.error_json,
                    NEW.retry_count, NEW.created_at, NEW.started_at, NEW.updated_at, NEW.finished_at);
            END;
            CREATE TRIGGER sync_image_generation_update
            AFTER UPDATE ON image_generation_tasks BEGIN
                UPDATE generation_records SET status = NEW.status, progress = NEW.progress,
                    remote_task_id = NEW.remote_task_id, result_relative_path = NEW.result_relative_path,
                    result_absolute_path = NEW.result_absolute_path, result_mime_type = NEW.result_mime_type,
                    result_json = COALESCE(NEW.result_json, generation_records.result_json), error_json = NEW.error_json,
                    retry_count = NEW.retry_count, started_at = NEW.started_at,
                    updated_at = NEW.updated_at, finished_at = NEW.finished_at
                WHERE id = NEW.id;
            END;
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                job_type TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                stage TEXT,
                payload_json TEXT,
                result_json TEXT,
                error_json TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                remote_job_id TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS job_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL,
                stage TEXT,
                message TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS project_versions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (1, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (2, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (3, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (4, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (5, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (6, datetime('now'));
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (7, datetime('now'));
            "#,
        )
        .map_err(|error| error.to_string())?;
    migrate_user_ownership(connection)
}

const USER_OWNED_TABLES: &[&str] = &[
    "projects",
    "project_sources",
    "creation_specs",
    "stories",
    "story_beats",
    "characters",
    "character_states",
    "scenes",
    "sequences",
    "shots",
    "shot_character_states",
    "assets",
    "image_generation_tasks",
    "generation_records",
    "automatic_workflows",
    "idea_development_workflows",
    "episodes",
    "jobs",
    "project_versions",
];

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    connection
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1)"),
            [column],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn migrate_user_ownership(connection: &Connection) -> Result<(), String> {
    for table in USER_OWNED_TABLES {
        if !has_column(connection, table, "user_id")? {
            connection
                .execute(
                    &format!("ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"),
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    let Ok(user_id) = crate::platform_session::current_user_id() else {
        return Ok(());
    };
    connection
        .execute(
            "UPDATE projects SET user_id = ?1 WHERE user_id = ''",
            [&user_id],
        )
        .map_err(|error| error.to_string())?;
    for table in USER_OWNED_TABLES
        .iter()
        .copied()
        .filter(|table| *table != "projects")
    {
        connection
            .execute(
                &format!("UPDATE {table} SET user_id = COALESCE((SELECT user_id FROM projects WHERE projects.id = {table}.project_id), '') WHERE user_id = ''"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch(&format!(
            "DROP TRIGGER IF EXISTS set_projects_user_id;
             CREATE TRIGGER set_projects_user_id AFTER INSERT ON projects WHEN NEW.user_id = '' BEGIN
               UPDATE projects SET user_id = '{user_id}' WHERE id = NEW.id;
             END;"
        ))
        .map_err(|error| error.to_string())?;
    for table in USER_OWNED_TABLES
        .iter()
        .copied()
        .filter(|table| *table != "projects")
    {
        connection
            .execute_batch(&format!(
                "DROP TRIGGER IF EXISTS set_{table}_user_id;
                 CREATE TRIGGER set_{table}_user_id AFTER INSERT ON {table} WHEN NEW.user_id = '' BEGIN
                   UPDATE {table} SET user_id = COALESCE((SELECT user_id FROM projects WHERE id = NEW.project_id), '') WHERE rowid = NEW.rowid;
                 END;"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_current_schema_does_not_rebuild_triggers() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let version: i64 = connection.query_row("PRAGMA schema_version", [], |r| r.get(0)).unwrap();
        for _ in 0..20 { migrate(&connection).unwrap(); }
        assert_eq!(connection.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0)).unwrap(), version);
    }

    #[test]
    fn concurrent_upgrade_and_task_updates_are_atomic() {
        let root = std::env::temp_dir().join(format!("aivs-concurrent-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let connection = crate::database::open(&root).unwrap();
        connection.execute("DELETE FROM schema_migrations WHERE version=?1", [CURRENT_VERSION]).unwrap();
        drop(connection);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|n| {
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for i in 0..15 {
                    let connection = crate::database::open(&root).unwrap();
                    let id = format!("P_{n}_{i}");
                    connection.execute("INSERT INTO projects(id,name,project_path,input_type,status,created_at,updated_at) VALUES (?1,'test','test','IDEA','DRAFT','now','now')", [&id]).unwrap();
                    let task = crate::database::image_tasks::create(&connection, crate::database::image_tasks::NewImageGenerationTask {
                        project_id: &id, target_type: "scene", target_id: "S1", base_url: "http://localhost", model: "test", protocol: "platform", prompt: "test", aspect_ratio: "9:16",
                    }).unwrap();
                    crate::database::image_tasks::mark_running(&connection, &task.id).unwrap();
                    crate::database::image_tasks::fail(&connection, &task.id, "simulated failure").unwrap();
                    assert_eq!(crate::database::generation_records::get(&connection, &task.id).unwrap().unwrap().status, "FAILED");
                }
            })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_character_state_relationship_tables() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        for table in ["character_states", "shot_character_states"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing table {table}");
        }
    }

    #[test]
    fn records_user_id_on_every_project_business_table() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        for table in USER_OWNED_TABLES {
            assert!(
                has_column(&connection, table, "user_id").unwrap(),
                "missing user_id on {table}"
            );
        }
        connection.execute(
            "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
             VALUES ('P_OWNER', 'owner test', 'test', 'IDEA', 'DRAFT', 'now', 'now')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO assets(id, project_id, asset_type, owner_type, owner_id, relative_path, status, data_json, created_at)
             VALUES ('A_OWNER', 'P_OWNER', 'IMAGE', 'scene', 'S1', 'test.png', 'READY', '{}', 'now')",
            [],
        ).unwrap();
        let project_owner: String = connection
            .query_row(
                "SELECT user_id FROM projects WHERE id = 'P_OWNER'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let asset_owner: String = connection
            .query_row(
                "SELECT user_id FROM assets WHERE id = 'A_OWNER'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_owner, "test-user");
        assert_eq!(asset_owner, project_owner);
    }
}
