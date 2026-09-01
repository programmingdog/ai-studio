use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn load_bundle(connection: &Connection) -> Result<Value, String> {
    let project: Value = connection
        .query_row(
            "SELECT id, name, project_path, input_type, status, created_at, updated_at FROM projects LIMIT 1",
            [],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "project_path": row.get::<_, String>(2)?,
                    "input_type": row.get::<_, String>(3)?,
                    "status": row.get::<_, String>(4)?,
                    "created_at": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                }))
            },
        )
        .map_err(|error| error.to_string())?;
    let project_id = project["id"].as_str().unwrap_or_default();
    let creation_spec: Value = connection
        .query_row(
            "SELECT data_json FROM creation_specs WHERE project_id = ?1",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())
        .and_then(parse_json)?;
    let source = connection
        .query_row(
            "SELECT source_type, COALESCE(source_text, ''), source_path FROM project_sources WHERE project_id = ?1 ORDER BY created_at LIMIT 1",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| ("IDEA".to_owned(), String::new(), None));

    let story = read_single_json(
        connection,
        "SELECT data_json FROM stories WHERE project_id = ?1",
        project_id,
    )?;
    let canonical = if let Some(story) = story {
        let mut characters = read_json_list(
            connection,
            "SELECT data_json FROM characters WHERE project_id = ?1 ORDER BY id",
            project_id,
        )?;
        hydrate_character_states(connection, project_id, &mut characters)?;
        let mut shots = read_json_list(
            connection,
            "SELECT data_json FROM shots WHERE project_id = ?1 ORDER BY shot_order",
            project_id,
        )?;
        hydrate_shot_character_states(connection, project_id, &characters, &mut shots)?;
        let mut canonical = json!({
            "story": story,
            "episodes": super::episodes::list(connection, project_id)?,
            "characters": characters,
            "scenes": read_json_list(connection, "SELECT data_json FROM scenes WHERE project_id = ?1 ORDER BY id", project_id)?,
            "sequences": read_json_list(connection, "SELECT data_json FROM sequences WHERE project_id = ?1 ORDER BY sequence_order", project_id)?,
            "shots": shots,
        });
        // 旧项目也按当前规则展示；保存时会由 save_canonical 正式写回。
        crate::story_policy::normalize(&mut canonical);
        crate::character_state_policy::normalize(&mut canonical);
        crate::shot_policy::normalize(&mut canonical);
        Some(canonical)
    } else {
        None
    };
    let jobs = read_jobs(connection, project_id)?;
    let image_tasks = super::image_tasks::list_for_project(connection, project_id)?;
    Ok(json!({
        "project": project,
        "creation_spec": creation_spec,
        "source_type": source.0,
        "source_text": source.1,
        "source_path": source.2,
        "canonical": canonical,
        "jobs": jobs,
        "image_tasks": image_tasks,
    }))
}

fn hydrate_character_states(
    connection: &Connection,
    project_id: &str,
    characters: &mut [Value],
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT character_id, data_json FROM character_states
             WHERE project_id = ?1 ORDER BY character_id, state_order",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let states = rows
        .map(|row| {
            let (character_id, raw) = row.map_err(|error| error.to_string())?;
            Ok((character_id, parse_json(raw)?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    for character in characters {
        let character_id = text(character, "id");
        let mut matching = states
            .iter()
            .filter(|(owner_id, _)| owner_id == &character_id)
            .map(|(_, state)| state.clone())
            .collect::<Vec<_>>();
        if matching.is_empty() {
            matching = character_states(character);
        }
        character["states"] = Value::Array(matching);
    }
    Ok(())
}

fn hydrate_shot_character_states(
    connection: &Connection,
    project_id: &str,
    characters: &[Value],
    shots: &mut [Value],
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT shot_id, character_id, state_id FROM shot_character_states
             WHERE project_id = ?1 ORDER BY shot_id, character_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for shot in shots {
        let shot_id = text(shot, "id");
        let mut mappings = rows
            .iter()
            .filter(|(owner_id, _, _)| owner_id == &shot_id)
            .map(|(_, character_id, state_id)| {
                (character_id.clone(), Value::String(state_id.clone()))
            })
            .collect::<serde_json::Map<_, _>>();
        if mappings.is_empty() {
            let context = format!(
                "{} {}",
                shot.get("visual")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                shot.get("action")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
            for character_id in shot
                .get("character_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let Some(character) = characters.iter().find(|character| {
                    character.get("id").and_then(Value::as_str) == Some(character_id)
                }) else {
                    continue;
                };
                let Some(states) = character.get("states").and_then(Value::as_array) else {
                    continue;
                };
                let selected = states
                    .iter()
                    .rev()
                    .find(|state| {
                        let name = state
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let keyword = name.trim_end_matches("状态");
                        (!name.is_empty() && context.contains(name))
                            || (keyword.chars().count() >= 2 && context.contains(keyword))
                    })
                    .or_else(|| states.first());
                if let Some(state_id) = selected
                    .and_then(|state| state.get("id"))
                    .and_then(Value::as_str)
                {
                    mappings.insert(character_id.to_owned(), json!(state_id));
                }
            }
        }
        if !mappings.is_empty() {
            shot["character_state_ids"] = Value::Object(mappings);
        }
    }
    Ok(())
}

fn parse_json(raw: String) -> Result<Value, String> {
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn read_single_json(
    connection: &Connection,
    sql: &str,
    project_id: &str,
) -> Result<Option<Value>, String> {
    let raw = connection
        .query_row(sql, [project_id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(parse_json).transpose()
}

fn read_json_list(
    connection: &Connection,
    sql: &str,
    project_id: &str,
) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()).and_then(parse_json))
        .collect()
}

fn read_jobs(connection: &Connection, project_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare("SELECT id, project_id, job_type, status, progress, stage, error_json FROM jobs WHERE project_id = ?1 ORDER BY created_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            let error_raw: Option<String> = row.get(6)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "project_id": row.get::<_, Option<String>>(1)?,
                "job_type": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "progress": row.get::<_, f64>(4)?,
                "stage": row.get::<_, Option<String>>(5)?,
                "error": error_raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
            }))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

pub fn save_canonical(
    connection: &mut Connection,
    project_id: &str,
    canonical: &Value,
) -> Result<(), String> {
    // 所有项目入口最终都会经过这里。保存前统一收敛角色状态，避免某条生成链路
    // 因情绪、动作或场景变化创建无意义的重复状态。
    let mut normalized_canonical = canonical.clone();
    crate::story_policy::normalize(&mut normalized_canonical);
    crate::character_state_policy::normalize(&mut normalized_canonical);
    crate::shot_policy::normalize(&mut normalized_canonical);
    let canonical = &normalized_canonical;
    let now = Utc::now().to_rfc3339();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let snapshot_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM project_versions WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO project_versions(id, project_id, version, snapshot_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![uuid::Uuid::new_v4().to_string(), project_id, snapshot_count + 1, canonical.to_string(), now],
    ).map_err(|error| error.to_string())?;

    let story = canonical
        .get("story")
        .ok_or("canonical.story is required")?;
    transaction.execute(
        "INSERT INTO stories(project_id, data_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(project_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at",
        params![project_id, story.to_string(), now],
    ).map_err(|error| error.to_string())?;

    for table in [
        "shot_character_states",
        "character_states",
        "story_beats",
        "shots",
        "sequences",
        "scenes",
        "characters",
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE project_id = ?1"),
                [project_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(episodes) = canonical.get("episodes").and_then(Value::as_array) {
        transaction
            .execute("DELETE FROM episodes WHERE project_id = ?1", [project_id])
            .map_err(|error| error.to_string())?;
        for (index, episode) in episodes.iter().enumerate() {
            transaction.execute(
                "INSERT INTO episodes(id, project_id, episode_order, title, duration, data_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![text(episode, "id"), project_id, index as i64, text(episode, "title"), number(episode, "duration"), episode.to_string()],
            ).map_err(|error| error.to_string())?;
        }
    }
    if let Some(beats) = story.get("beats").and_then(Value::as_array) {
        for (index, beat) in beats.iter().enumerate() {
            transaction.execute(
                "INSERT INTO story_beats(id, project_id, beat_order, data_json) VALUES (?1, ?2, ?3, ?4)",
                params![format!("{project_id}:BEAT_{:03}", index + 1), project_id, index as i64, beat.to_string()],
            ).map_err(|error| error.to_string())?;
        }
    }
    let mut valid_character_states = HashSet::new();
    for character in array(canonical, "characters")? {
        let mut character = character.clone();
        let character_id = text(&character, "id");
        let states = character_states(&character)
            .into_iter()
            .map(|state| {
                merge_completed_image_assets(&transaction, project_id, "character_state", &state)
            })
            .collect::<Result<Vec<_>, _>>()?;
        character["states"] = Value::Array(states.clone());
        let character =
            merge_completed_image_assets(&transaction, project_id, "character", &character)?;
        transaction.execute(
            "INSERT INTO characters(id, project_id, name, role, data_json, locked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![text(&character, "id"), project_id, text(&character, "name"), text(&character, "role"), character.to_string(), boolean(&character, "locked"), now],
        ).map_err(|error| error.to_string())?;
        for (index, state) in states.iter().enumerate() {
            let state_id = text(state, "id");
            valid_character_states.insert((character_id.clone(), state_id.clone()));
            transaction.execute(
                "INSERT INTO character_states(id, project_id, character_id, state_order, name, data_json, locked, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![state_id, project_id, character_id, index as i64, text(state, "name"), state.to_string(), boolean(state, "locked"), now],
            ).map_err(|error| error.to_string())?;
        }
    }
    for scene in array(canonical, "scenes")? {
        let scene = merge_completed_image_assets(&transaction, project_id, "scene", scene)?;
        transaction.execute(
            "INSERT INTO scenes(id, project_id, name, data_json, locked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![text(&scene, "id"), project_id, text(&scene, "name"), scene.to_string(), boolean(&scene, "locked"), now],
        ).map_err(|error| error.to_string())?;
    }
    for (index, sequence) in array(canonical, "sequences")?.iter().enumerate() {
        transaction.execute(
            "INSERT INTO sequences(id, project_id, sequence_order, data_json) VALUES (?1, ?2, ?3, ?4)",
            params![text(sequence, "id"), project_id, index as i64, sequence.to_string()],
        ).map_err(|error| error.to_string())?;
    }
    for (index, shot) in array(canonical, "shots")?.iter().enumerate() {
        let shot = merge_completed_image_assets(&transaction, project_id, "shot", shot)?;
        let shot = merge_completed_video_assets(&transaction, project_id, &shot)?;
        transaction.execute(
            "INSERT INTO shots(id, project_id, sequence_id, scene_id, shot_order, duration, data_json, status, locked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![text(&shot, "id"), project_id, text(&shot, "sequence_id"), text(&shot, "scene_id"), index as i64, number(&shot, "duration"), shot.to_string(), text(&shot, "status"), boolean(&shot, "locked"), now],
        ).map_err(|error| error.to_string())?;
        if let Some(mappings) = shot.get("character_state_ids").and_then(Value::as_object) {
            for (character_id, state_id) in mappings {
                let Some(state_id) = state_id.as_str() else {
                    continue;
                };
                if !valid_character_states.contains(&(character_id.clone(), state_id.to_owned())) {
                    continue;
                }
                transaction.execute(
                    "INSERT INTO shot_character_states(project_id, shot_id, character_id, state_id)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![project_id, text(&shot, "id"), character_id, state_id],
                ).map_err(|error| error.to_string())?;
            }
        }
    }
    transaction
        .execute(
            "UPDATE projects SET status = 'ACTIVE', updated_at = ?1 WHERE id = ?2",
            params![now, project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn character_states(character: &Value) -> Vec<Value> {
    let states = character
        .get("states")
        .and_then(Value::as_array)
        .filter(|states| !states.is_empty())
        .cloned();
    states.unwrap_or_else(|| {
        let character_id = text(character, "id");
        let appearance_lock = character
            .get("appearance_lock")
            .and_then(Value::as_str)
            .unwrap_or("五官和体态保持一致");
        let clothing_lock = character
            .get("clothing_lock")
            .and_then(Value::as_str)
            .unwrap_or("服装保持一致");
        vec![json!({
            "id": format!("{character_id}_STATE_001"),
            "name": "默认状态",
            "trigger": "角色常规出场",
            "description": character.get("appearance_lock").and_then(Value::as_str).unwrap_or("角色基础形象"),
            "appearance_lock": appearance_lock,
            "clothing_lock": clothing_lock,
            "reference_assets": character.get("reference_assets").cloned().unwrap_or_else(|| json!([])),
            "locked": false
        })]
    })
}

fn merge_completed_image_assets(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    target_type: &str,
    entity: &Value,
) -> Result<Value, String> {
    let mut merged = entity.clone();
    let target_id = text(entity, "id");
    let mut statement = transaction
        .prepare(
            "SELECT result_relative_path FROM image_generation_tasks
             WHERE project_id = ?1 AND target_type = ?2 AND target_id = ?3
               AND status = 'COMPLETED' AND result_relative_path IS NOT NULL
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let paths = statement
        .query_map(params![project_id, target_type, target_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if paths.is_empty() {
        return Ok(merged);
    }
    let object = merged
        .as_object_mut()
        .ok_or_else(|| format!("{target_type} 数据不是对象"))?;
    let assets = object
        .entry("reference_assets")
        .or_insert_with(|| Value::Array(Vec::new()));
    let array = assets
        .as_array_mut()
        .ok_or_else(|| "reference_assets 不是数组".to_owned())?;
    for path in paths.into_iter().rev() {
        array.retain(|value| value.as_str() != Some(&path));
        array.insert(0, Value::String(path));
    }
    Ok(merged)
}

fn merge_completed_video_assets(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    shot: &Value,
) -> Result<Value, String> {
    let mut merged = shot.clone();
    let shot_id = text(shot, "id");
    let mut statement = transaction
        .prepare(
            "SELECT result_relative_path FROM generation_records WHERE project_id = ?1
         AND media_type = 'video' AND target_type = 'shot' AND target_id = ?2
         AND status = 'COMPLETED' AND result_relative_path IS NOT NULL ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let paths = statement
        .query_map(params![project_id, shot_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if paths.is_empty() {
        return Ok(merged);
    }
    let assets = merged
        .as_object_mut()
        .ok_or("shot 数据不是对象")?
        .entry("video_assets")
        .or_insert_with(|| Value::Array(Vec::new()));
    let array = assets.as_array_mut().ok_or("video_assets 不是数组")?;
    for path in paths.into_iter().rev() {
        array.retain(|value| value.as_str() != Some(&path));
        array.insert(0, Value::String(path));
    }
    Ok(merged)
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("canonical.{key} must be an array"))
}
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_default()
}
fn boolean(value: &Value, key: &str) -> i64 {
    i64::from(value.get(key).and_then(Value::as_bool).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_string_story_beats_with_unique_storage_ids_repeatedly() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO projects(id, name, project_path, input_type, status, created_at, updated_at)
             VALUES ('P_TEST', '二创保存测试', 'test', 'SCRIPT', 'DRAFT', 'now', 'now')",
            [],
        ).unwrap();
        let canonical = json!({
            "story": {
                "title":"雪线灯火",
                "logline":"建设者守护山村通道",
                "genre":["现实"],
                "theme":"建设为了人民",
                "synopsis":"完整故事概要",
                "tone":"纪实",
                "beats":["发现冻土沉降", "重新测量并加固", "校车安全通过"]
            },
            "episodes":[],
            "characters":[],
            "scenes":[],
            "sequences":[],
            "shots":[]
        });
        save_canonical(&mut connection, "P_TEST", &canonical).unwrap();
        save_canonical(&mut connection, "P_TEST", &canonical).unwrap();
        let rows = connection
            .prepare("SELECT id, data_json FROM story_beats ORDER BY beat_order")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, "P_TEST:BEAT_001");
        assert_eq!(
            serde_json::from_str::<Value>(&rows[0].1).unwrap()["id"],
            "BEAT_001"
        );
    }
}
