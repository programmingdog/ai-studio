use rusqlite::{params, Connection};
use serde_json::Value;

pub fn replace(
    connection: &mut Connection,
    project_id: &str,
    episodes: &[Value],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM episodes WHERE project_id = ?1", [project_id])
        .map_err(|error| error.to_string())?;
    for (index, episode) in episodes.iter().enumerate() {
        let id = episode
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("EP_{:03}", index + 1));
        let title = episode
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("未命名分集");
        let duration = episode
            .get("duration")
            .and_then(Value::as_f64)
            .unwrap_or(90.0);
        transaction
            .execute(
                "INSERT INTO episodes(id, project_id, episode_order, title, duration, data_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    project_id,
                    index as i64,
                    title,
                    duration,
                    episode.to_string()
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list(connection: &Connection, project_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare("SELECT data_json FROM episodes WHERE project_id = ?1 ORDER BY episode_order")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        row.map_err(|error| error.to_string())
            .and_then(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replaces_and_orders_project_episodes() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection.execute("INSERT INTO projects(id,name,project_path,input_type,status,created_at,updated_at) VALUES('P1','长篇','C:/p','IDEA','DRAFT','now','now')", []).unwrap();
        replace(
            &mut connection,
            "P1",
            &[
                json!({"id":"EP_001","order":1,"title":"开端","duration":90,"content":"事件发生"}),
                json!({"id":"EP_002","order":2,"title":"追查","duration":90,"content":"主角追查"}),
            ],
        )
        .unwrap();
        let loaded = list(&connection, "P1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1]["title"], "追查");
    }
}
