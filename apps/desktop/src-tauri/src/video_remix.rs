use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::Duration,
};

use crate::project::{manager, registry};

const MAX_GENERATION_ATTEMPTS: usize = 3;

fn default_storyboard_duration_mode() -> String {
    "legacy".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVideoRemixTaskInput {
    source_task_id: String,
    project_name: String,
    creative_direction: String,
    originality: String,
    #[serde(default = "default_storyboard_duration_mode")]
    storyboard_duration_mode: String,
    target_duration: f64,
    aspect_ratio: String,
    visual_style: String,
    language: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateVideoRemixProjectInput {
    remix_task_id: String,
    root_path: String,
    project_name: String,
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::platform_session::user_scoped_sqlite(app, "douyin-understanding.db")
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS video_remix_tasks (
                id TEXT PRIMARY KEY,
                source_task_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                input_json TEXT NOT NULL,
                result_json TEXT,
                error_json TEXT,
                project_path TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_video_remix_source_created
                ON video_remix_tasks(source_task_id, created_at DESC);",
        )
        .map_err(|error| error.to_string())?;
    crate::platform_session::bind_user_owned_tables(&connection, &["video_remix_tasks"])?;
    Ok(connection)
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let input_json: String = row.get(7)?;
    let result_json: Option<String> = row.get(8)?;
    let error_json: Option<String> = row.get(9)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "source_task_id": row.get::<_, String>(1)?,
        "project_name": row.get::<_, String>(2)?,
        "status": row.get::<_, String>(3)?,
        "stage": row.get::<_, String>(4)?,
        "progress": row.get::<_, f64>(5)?,
        "message": row.get::<_, String>(6)?,
        "input": serde_json::from_str::<Value>(&input_json).unwrap_or_else(|_| json!({})),
        "result": result_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "error": error_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "project_path": row.get::<_, Option<String>>(10)?,
        "created_at": row.get::<_, String>(11)?,
        "updated_at": row.get::<_, String>(12)?,
        "finished_at": row.get::<_, Option<String>>(13)?,
    }))
}

const SELECT_TASK: &str = "SELECT id, source_task_id, project_name, status, stage, progress,
    message, input_json, result_json, error_json, project_path, created_at, updated_at, finished_at
    FROM video_remix_tasks";

fn get_task(app: &tauri::AppHandle, task_id: &str) -> Result<Value, String> {
    open(app)?
        .query_row(
            &format!("{SELECT_TASK} WHERE id = ?1"),
            [task_id],
            task_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "二次创作任务不存在".to_owned())
}

fn update_progress(app: &tauri::AppHandle, task_id: &str, progress: f64, message: &str) {
    if let Ok(connection) = open(app) {
        let _ = connection.execute(
            "UPDATE video_remix_tasks SET status = 'RUNNING', stage = 'generating', progress = ?2,
             message = ?3, updated_at = ?4 WHERE id = ?1",
            params![task_id, progress, message, Utc::now().to_rfc3339()],
        );
    }
}

fn failure_value(message: String) -> Value {
    serde_json::from_str::<Value>(&message).unwrap_or_else(
        |_| json!({"code": "VIDEO_REMIX_FAILED", "message": message, "retryable": true}),
    )
}

fn finish_failed(app: &tauri::AppHandle, task_id: &str, message: String) {
    let error = failure_value(message);
    if let (Ok(connection), Ok(error_json)) = (open(app), serde_json::to_string(&error)) {
        let now = Utc::now().to_rfc3339();
        let _ = connection.execute(
            "UPDATE video_remix_tasks SET status = 'FAILED', stage = 'failed', progress = 0,
             message = '二次创作失败', error_json = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
            params![task_id, error_json, now],
        );
    }
}

fn required_array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    let items = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("二创结果缺少 {key} 数组"))?;
    if items.is_empty() {
        return Err(format!("二创结果的 {key} 不能为空"));
    }
    Ok(items)
}

fn meaningful_text(value: &Value, key: &str, minimum: usize) -> Result<String, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if text.chars().count() < minimum {
        return Err(format!("二创结果字段 {key} 内容过短"));
    }
    let placeholders = ["按剧情", "自然运镜", "自然行动", "待补充", "同上", "占位"];
    if placeholders
        .iter()
        .any(|placeholder| text.contains(placeholder))
    {
        return Err(format!("二创结果字段 {key} 使用了模板占位内容"));
    }
    Ok(text.to_owned())
}

fn note_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        Value::Array(items) => {
            let lines = items.iter().filter_map(note_text).collect::<Vec<_>>();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        Value::Object(object) => {
            let content = object
                .get("text")
                .or_else(|| object.get("dialogue"))
                .or_else(|| object.get("content"))
                .or_else(|| object.get("summary"))
                .or_else(|| object.get("description"))
                .or_else(|| object.get("title"))
                .and_then(note_text);
            let speaker = object
                .get("character_name")
                .or_else(|| object.get("character_id"))
                .or_else(|| object.get("speaker"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty());
            content.map(|text| match speaker {
                Some(speaker) => format!("{speaker}：{text}"),
                None => text,
            })
        }
        Value::Null => None,
    }
    .filter(|text| !text.is_empty())
}

fn normalize_object_text_field(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    fallback: &str,
) {
    let text = object
        .get(key)
        .and_then(note_text)
        .unwrap_or_else(|| fallback.to_owned());
    object.insert(key.to_owned(), Value::String(text));
}

fn normalize_note_list(value: Option<&Value>) -> Vec<Value> {
    let source = match value {
        Some(Value::Array(items)) => items.iter().filter_map(note_text).collect::<Vec<_>>(),
        Some(Value::String(text)) => text
            .split(|character| matches!(character, '\n' | '；' | ';'))
            .map(|item| {
                item.trim()
                    .trim_start_matches(|character: char| {
                        character.is_ascii_digit()
                            || matches!(character, '-' | '*' | '•' | '.' | '、' | ' ')
                    })
                    .trim()
                    .to_owned()
            })
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>(),
        Some(Value::Object(object)) => note_text(&Value::Object(object.clone()))
            .into_iter()
            .chain(object.iter().filter_map(|(key, value)| {
                note_text(value)
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| format!("{key}：{text}"))
            }))
            .collect::<Vec<_>>(),
        Some(other) => note_text(other).into_iter().collect(),
        None => Vec::new(),
    };
    source.into_iter().map(Value::String).collect()
}

fn adaptation_note_candidate(result: &Value, aliases: &[&str]) -> Option<Value> {
    let containers = [
        Some(result),
        result.get("adaptation_notes"),
        result.pointer("/canonical/story"),
    ];
    containers
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find_map(|container| {
            aliases
                .iter()
                .filter_map(|alias| container.get(*alias))
                .find(|value| !normalize_note_list(Some(value)).is_empty())
                .cloned()
        })
}

fn normalize_adaptation_note_aliases(result: &mut Value) {
    let fields = [
        (
            "source_structure",
            &[
                "source_structure",
                "sourceStructure",
                "story_structure",
                "narrative_structure",
                "structure",
                "结构骨架",
            ][..],
        ),
        (
            "conflict_design",
            &[
                "conflict_design",
                "conflictDesign",
                "conflict_escalation",
                "conflicts",
                "conflict",
                "冲突设计",
                "冲突升级",
            ][..],
        ),
        (
            "reversal_design",
            &[
                "reversal_design",
                "reversalDesign",
                "reversals",
                "plot_twists",
                "twists",
                "reversal",
                "反转设计",
                "反转",
            ][..],
        ),
        (
            "originality_statement",
            &[
                "originality_statement",
                "originalityStatement",
                "originality",
                "原创差异",
                "原创说明",
            ][..],
        ),
    ];
    let candidates = fields
        .iter()
        .map(|(key, aliases)| {
            (
                (*key).to_owned(),
                adaptation_note_candidate(result, aliases),
            )
        })
        .collect::<Vec<_>>();
    let Some(result) = result.as_object_mut() else {
        return;
    };
    let notes = result
        .entry("adaptation_notes")
        .or_insert_with(|| json!({}));
    if !notes.is_object() {
        *notes = json!({});
    }
    let notes = notes
        .as_object_mut()
        .expect("adaptation_notes normalized to object");
    for (key, candidate) in candidates {
        let missing = notes
            .get(&key)
            .is_none_or(|value| normalize_note_list(Some(value)).is_empty());
        if missing {
            if let Some(candidate) = candidate {
                notes.insert(key, candidate);
            }
        }
    }
}

fn substantive_design_count(value: Option<&Value>) -> usize {
    let mut unique = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(note_text)
        .map(|text| text.trim().to_owned())
        .filter(|text| text.chars().count() >= 8)
        .filter(|text| unique.insert(reference_key(text)))
        .count()
}

fn validate_radical_design(notes: &serde_json::Map<String, Value>) -> Result<(), String> {
    let conflict_count = substantive_design_count(notes.get("conflict_design"));
    if conflict_count < 3 {
        return Err(format!(
            "激进原创要求至少3个具体且逐级加压的冲突升级节点，当前只有{conflict_count}个"
        ));
    }
    let reversal_count = substantive_design_count(notes.get("reversal_design"));
    if reversal_count < 2 {
        return Err(format!(
            "激进原创要求至少2次有铺垫、因果和后续影响的有效反转，当前只有{reversal_count}次"
        ));
    }
    Ok(())
}

fn reference_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '｜' | '|'))
        .flat_map(char::to_uppercase)
        .collect()
}

fn resolve_reference(aliases: &HashMap<String, String>, value: Option<&str>) -> Option<String> {
    value
        .map(reference_key)
        .filter(|key| !key.is_empty())
        .and_then(|key| aliases.get(&key).cloned())
}

/// Repairs the common structural variations returned by text models before strict validation.
/// Scene and sequence IDs are made stable, while references by old ID, name, case variant,
/// scene ID, or sequence shot membership are redirected to their canonical IDs.
fn normalize_remix_structure(result: &mut Value) -> Result<(), String> {
    let canonical = result
        .get_mut("canonical")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "二创结果的 canonical 不是对象".to_owned())?;

    let scenes = canonical
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "二创结果缺少 scenes 数组".to_owned())?;
    if scenes.is_empty() {
        return Err("二创结果的 scenes 不能为空".to_owned());
    }
    let mut scene_aliases = HashMap::<String, String>::new();
    let mut scene_ids = Vec::with_capacity(scenes.len());
    for (index, scene) in scenes.iter_mut().enumerate() {
        let object = scene
            .as_object_mut()
            .ok_or_else(|| format!("第{}个场景不是对象", index + 1))?;
        let canonical_id = format!("SCENE_{:03}", index + 1);
        for alias in [
            object.get("id").and_then(Value::as_str),
            object.get("name").and_then(Value::as_str),
            object.get("title").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        {
            scene_aliases.insert(reference_key(alias), canonical_id.clone());
        }
        scene_aliases.insert(reference_key(&canonical_id), canonical_id.clone());
        object.insert("id".to_owned(), json!(canonical_id.clone()));
        scene_ids.push(canonical_id);
    }

    let mut sequences = canonical
        .remove("sequences")
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| "二创结果缺少 sequences 数组".to_owned())?;
    if sequences.is_empty() {
        return Err("二创结果的 sequences 不能为空".to_owned());
    }
    let mut sequence_aliases = HashMap::<String, String>::new();
    let mut sequence_ids = Vec::with_capacity(sequences.len());
    let mut sequence_scene_ids = Vec::with_capacity(sequences.len());
    let mut shot_owner_aliases = HashMap::<String, String>::new();
    for (index, sequence) in sequences.iter_mut().enumerate() {
        let object = sequence
            .as_object_mut()
            .ok_or_else(|| format!("第{}个场次不是对象", index + 1))?;
        let canonical_id = format!("SEQ_{:03}", index + 1);
        for alias in [
            object.get("id").and_then(Value::as_str),
            object.get("name").and_then(Value::as_str),
            object.get("title").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        {
            sequence_aliases.insert(reference_key(alias), canonical_id.clone());
        }
        sequence_aliases.insert(reference_key(&canonical_id), canonical_id.clone());
        if let Some(shot_ids) = object.get("shot_ids").and_then(Value::as_array) {
            for shot_id in shot_ids.iter().filter_map(Value::as_str) {
                shot_owner_aliases.insert(reference_key(shot_id), canonical_id.clone());
            }
        }
        let scene_id = resolve_reference(
            &scene_aliases,
            object
                .get("scene_id")
                .and_then(Value::as_str)
                .or_else(|| object.get("scene").and_then(Value::as_str))
                .or_else(|| object.get("scene_name").and_then(Value::as_str)),
        )
        .unwrap_or_else(|| scene_ids[index.min(scene_ids.len() - 1)].clone());
        object.insert("id".to_owned(), json!(canonical_id.clone()));
        object.insert("scene_id".to_owned(), json!(scene_id.clone()));
        sequence_ids.push(canonical_id);
        sequence_scene_ids.push(scene_id);
    }

    let shots = canonical
        .get_mut("shots")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "二创结果缺少 shots 数组".to_owned())?;
    let shot_count = shots.len().max(1);
    let mut rebuilt_shot_ids = vec![Vec::<Value>::new(); sequence_ids.len()];
    for (index, shot) in shots.iter_mut().enumerate() {
        let object = shot
            .as_object_mut()
            .ok_or_else(|| format!("第{}个分镜不是对象", index + 1))?;
        let original_shot_id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let shot_id = format!("SHOT_{:03}", index + 1);
        let proposed_scene = resolve_reference(
            &scene_aliases,
            object
                .get("scene_id")
                .and_then(Value::as_str)
                .or_else(|| object.get("scene").and_then(Value::as_str))
                .or_else(|| object.get("scene_name").and_then(Value::as_str)),
        );
        let sequence_id = resolve_reference(
            &sequence_aliases,
            object
                .get("sequence_id")
                .and_then(Value::as_str)
                .or_else(|| object.get("sequence").and_then(Value::as_str))
                .or_else(|| object.get("sequence_name").and_then(Value::as_str)),
        )
        .or_else(|| {
            shot_owner_aliases
                .get(&reference_key(&original_shot_id))
                .cloned()
        })
        .or_else(|| {
            proposed_scene.as_ref().and_then(|scene_id| {
                sequence_scene_ids
                    .iter()
                    .position(|candidate| candidate == scene_id)
                    .map(|owner| sequence_ids[owner].clone())
            })
        })
        .unwrap_or_else(|| {
            let owner = (index * sequence_ids.len() / shot_count).min(sequence_ids.len() - 1);
            sequence_ids[owner].clone()
        });
        let sequence_index = sequence_ids
            .iter()
            .position(|candidate| candidate == &sequence_id)
            .unwrap_or(0);
        let scene_id = sequence_scene_ids[sequence_index].clone();
        object.insert("id".to_owned(), json!(shot_id.clone()));
        object.insert("sequence_id".to_owned(), json!(sequence_id));
        object.insert("scene_id".to_owned(), json!(scene_id));
        rebuilt_shot_ids[sequence_index].push(json!(shot_id));
    }
    for (sequence, shot_ids) in sequences.iter_mut().zip(rebuilt_shot_ids) {
        if let Some(object) = sequence.as_object_mut() {
            object.insert("shot_ids".to_owned(), Value::Array(shot_ids));
        }
    }
    canonical.insert("sequences".to_owned(), Value::Array(sequences));
    Ok(())
}

fn validate_storyboard_durations(
    durations: &[f64],
    target_duration: f64,
    duration_mode: &str,
) -> Result<(), String> {
    let total_duration = durations.iter().sum::<f64>();
    if (total_duration - target_duration).abs() > 0.5 {
        return Err(format!(
            "分镜总时长不合法：要求{target_duration}秒，实际{total_duration}秒"
        ));
    }
    match duration_mode {
        "fixed" => {
            let expected_count = (target_duration / 10.0).ceil().max(1.0) as usize;
            if durations.len() != expected_count {
                return Err(format!(
                    "固定时长模式要求生成{expected_count}个分镜，实际生成{}个；除尾镜外每镜必须为10秒",
                    durations.len()
                ));
            }
            for (index, duration) in durations.iter().enumerate() {
                let expected = if index + 1 == expected_count {
                    target_duration - 10.0 * (expected_count.saturating_sub(1) as f64)
                } else {
                    10.0
                };
                if (*duration - expected).abs() > 0.01 {
                    return Err(format!(
                        "固定时长模式下第{}个分镜必须为{expected}秒，实际为{duration}秒",
                        index + 1
                    ));
                }
            }
        }
        "adaptive" => {
            for (index, duration) in durations.iter().enumerate() {
                if !(8.0..=15.0).contains(duration) {
                    return Err(format!(
                        "非固定时长模式下第{}个分镜必须在8～15秒之间，实际为{duration}秒",
                        index + 1
                    ));
                }
            }
        }
        "legacy" => {
            let shot_count = durations.len();
            for (index, duration) in durations.iter().enumerate() {
                let minimum = if index + 1 == shot_count { 1.0 } else { 10.0 };
                if !(minimum..=15.0).contains(duration) {
                    return Err(format!("第{}个分镜时长不合法：{duration}秒", index + 1));
                }
            }
        }
        _ => return Err("二创分镜时长模式无效".to_owned()),
    }
    Ok(())
}

fn first_object_text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find_map(note_text)
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn normalize_remix_character_states(result: &mut Value) -> Result<(), String> {
    let characters = result
        .pointer_mut("/canonical/characters")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "二创结果缺少 characters 数组".to_owned())?;
    for (character_index, character) in characters.iter_mut().enumerate() {
        let character = character
            .as_object_mut()
            .ok_or_else(|| format!("第{}个角色不是对象", character_index + 1))?;
        let character_id = first_object_text(character, &["id"])
            .unwrap_or_else(|| format!("CHAR_{:03}", character_index + 1));
        character.insert("id".to_owned(), json!(character_id.clone()));
        let appearance = character
            .get("appearance")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let face = first_object_text(&appearance, &["face"])
            .unwrap_or_else(|| "五官按角色基础设定保持一致".to_owned());
        let hair = first_object_text(&appearance, &["hair"])
            .unwrap_or_else(|| "发型与发色保持一致".to_owned());
        let body = first_object_text(&appearance, &["body"])
            .unwrap_or_else(|| "身高与体态保持一致".to_owned());
        let clothes = first_object_text(&appearance, &["clothes"])
            .unwrap_or_else(|| "服装按角色基础设定保持一致".to_owned());
        let accessories =
            first_object_text(&appearance, &["accessories"]).unwrap_or_else(|| "无".to_owned());
        let base_appearance =
            first_object_text(character, &["appearance_lock", "look_lock", "visual_lock"])
                .unwrap_or_else(|| format!("脸部：{face}；发型：{hair}；体态：{body}"));
        let mut base_clothing = first_object_text(
            character,
            &[
                "clothing_lock",
                "wardrobe_lock",
                "costume_lock",
                "outfit_lock",
            ],
        )
        .unwrap_or_else(|| format!("服装：{clothes}；装备与配饰：{accessories}"));
        if !base_clothing.contains("装备") {
            base_clothing.push_str(&format!("；装备与配饰：{accessories}"));
        }
        if !base_clothing.contains("伤") {
            base_clothing.push_str("；伤势：无");
        }
        character.insert("appearance_lock".to_owned(), json!(base_appearance.clone()));
        character.insert("clothing_lock".to_owned(), json!(base_clothing.clone()));

        if character.get("states").and_then(Value::as_array).is_none() {
            character.insert("states".to_owned(), json!([]));
        }
        let states = character
            .get_mut("states")
            .and_then(Value::as_array_mut)
            .expect("states was normalized to an array");
        if states.is_empty() {
            states.push(json!({}));
        }
        let state_count = states.len();
        for (state_index, state) in states.iter_mut().enumerate() {
            if !state.is_object() {
                let description = note_text(state).unwrap_or_default();
                *state = json!({"description": description});
            }
            let state = state
                .as_object_mut()
                .expect("character state was normalized to an object");
            let state_id = first_object_text(state, &["id", "state_id"])
                .unwrap_or_else(|| format!("{}_STATE_{:03}", character_id, state_index + 1));
            let state_name =
                first_object_text(state, &["name", "state_name", "form_name", "status_name"])
                    .unwrap_or_else(|| {
                        if state_count == 1 {
                            "默认状态".to_owned()
                        } else {
                            format!("状态{}", state_index + 1)
                        }
                    });
            let trigger = first_object_text(
                state,
                &[
                    "trigger",
                    "condition",
                    "trigger_condition",
                    "appearance_condition",
                    "usage_condition",
                ],
            )
            .unwrap_or_else(|| {
                if state_count == 1 {
                    "角色常规出场时".to_owned()
                } else {
                    format!("剧情进入“{state_name}”情境时")
                }
            });
            let appearance_lock = first_object_text(
                state,
                &["appearance_lock", "look_lock", "facial_lock", "body_lock"],
            )
            .unwrap_or_else(|| base_appearance.clone());
            let mut clothing_parts = [
                "clothing_lock",
                "wardrobe_lock",
                "costume_lock",
                "outfit_lock",
            ]
            .iter()
            .filter_map(|key| state.get(*key).and_then(note_text))
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>();
            if clothing_parts.is_empty() {
                clothing_parts.push(base_clothing.clone());
            }
            clothing_parts.extend(
                ["equipment_lock", "injury_lock"]
                    .iter()
                    .filter_map(|key| state.get(*key).and_then(note_text))
                    .filter(|text| !text.trim().is_empty()),
            );
            let mut clothing_lock = clothing_parts.join("；");
            if !clothing_lock.contains("装备") {
                clothing_lock.push_str("；装备：无");
            }
            if !clothing_lock.contains("伤") {
                clothing_lock.push_str("；伤势：无");
            }
            let description = first_object_text(
                state,
                &["description", "state_description", "visual_description"],
            )
            .unwrap_or_else(|| format!("{state_name}：{appearance_lock}；{clothing_lock}"));
            state.insert("id".to_owned(), json!(state_id));
            state.insert("name".to_owned(), json!(state_name));
            state.insert("trigger".to_owned(), json!(trigger));
            state.insert("description".to_owned(), json!(description));
            state.insert("appearance_lock".to_owned(), json!(appearance_lock));
            state.insert("clothing_lock".to_owned(), json!(clothing_lock));
            state.entry("reference_assets").or_insert_with(|| json!([]));
            state.entry("locked").or_insert_with(|| json!(false));
        }
    }
    Ok(())
}

/// Character-state IDs are primary keys in a project database, so IDs such as
/// `STATE_001` cannot be reused by different characters. Providers commonly
/// number every character's first state this way. Run this after the generic
/// character-state policy has normalized the model's reference shapes, then
/// assign project-stable IDs and redirect every shot mapping to the new ID.
fn assign_unique_remix_character_state_ids(canonical: &mut Value) -> Result<(), String> {
    let characters = canonical
        .get_mut("characters")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "二创结果缺少 characters 数组".to_owned())?;
    let mut redirects = HashMap::<String, HashMap<String, String>>::new();
    let mut defaults = HashMap::<String, String>::new();
    let mut used_ids = HashSet::<String>::new();

    for (character_index, character) in characters.iter_mut().enumerate() {
        let character = character
            .as_object_mut()
            .ok_or_else(|| format!("第{}个角色不是对象", character_index + 1))?;
        let character_id = first_object_text(character, &["id"])
            .unwrap_or_else(|| format!("CHAR_{:03}", character_index + 1));
        let states = character
            .get_mut("states")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("第{}个角色缺少 states 数组", character_index + 1))?;
        let character_redirects = redirects.entry(character_id.clone()).or_default();

        for (state_index, state) in states.iter_mut().enumerate() {
            let state = state.as_object_mut().ok_or_else(|| {
                format!(
                    "第{}个角色的第{}个状态不是对象",
                    character_index + 1,
                    state_index + 1
                )
            })?;
            let old_id = first_object_text(state, &["id", "state_id"]).unwrap_or_default();
            let base_id = format!("{}_STATE_{:03}", character_id, state_index + 1);
            let mut state_id = base_id.clone();
            let mut suffix = 2;
            while !used_ids.insert(state_id.clone()) {
                state_id = format!("{base_id}_{suffix}");
                suffix += 1;
            }
            if !old_id.is_empty() {
                character_redirects
                    .entry(reference_key(&old_id))
                    .or_insert_with(|| state_id.clone());
            }
            character_redirects.insert(reference_key(&state_id), state_id.clone());
            if let Some(name) = first_object_text(state, &["name"]) {
                character_redirects
                    .entry(reference_key(&name))
                    .or_insert_with(|| state_id.clone());
            }
            if state_index == 0 {
                defaults.insert(character_id.clone(), state_id.clone());
            }
            state.insert("id".to_owned(), json!(state_id));
        }
    }

    if let Some(shots) = canonical.get_mut("shots").and_then(Value::as_array_mut) {
        for shot in shots {
            let Some(mappings) = shot
                .get_mut("character_state_ids")
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            for (character_id, state_id) in mappings.iter_mut() {
                let replacement = state_id
                    .as_str()
                    .and_then(|state_id| {
                        redirects
                            .get(character_id)
                            .and_then(|aliases| aliases.get(&reference_key(state_id)))
                    })
                    .or_else(|| defaults.get(character_id))
                    .cloned();
                if let Some(replacement) = replacement {
                    *state_id = json!(replacement);
                }
            }
        }
    }
    Ok(())
}

/// A text model cannot create files inside the new local project. Any media
/// names it emits are descriptive placeholders, not usable project-relative
/// paths. Real imported/generated assets are attached later by project tasks.
fn clear_remix_media_placeholders(canonical: &mut Value) {
    if let Some(characters) = canonical
        .get_mut("characters")
        .and_then(Value::as_array_mut)
    {
        for character in characters {
            let Some(character) = character.as_object_mut() else {
                continue;
            };
            character.insert("reference_assets".to_owned(), json!([]));
            if let Some(states) = character.get_mut("states").and_then(Value::as_array_mut) {
                for state in states {
                    if let Some(state) = state.as_object_mut() {
                        state.insert("reference_assets".to_owned(), json!([]));
                    }
                }
            }
        }
    }
    if let Some(scenes) = canonical.get_mut("scenes").and_then(Value::as_array_mut) {
        for scene in scenes {
            if let Some(scene) = scene.as_object_mut() {
                scene.insert("reference_assets".to_owned(), json!([]));
            }
        }
    }
    if let Some(shots) = canonical.get_mut("shots").and_then(Value::as_array_mut) {
        for shot in shots {
            if let Some(shot) = shot.as_object_mut() {
                shot.insert("reference_assets".to_owned(), json!([]));
                shot.insert("video_assets".to_owned(), json!([]));
            }
        }
    }
}

fn validate_result(mut result: Value, input: &CreateVideoRemixTaskInput) -> Result<Value, String> {
    normalize_remix_structure(&mut result)?;
    normalize_remix_character_states(&mut result)?;
    if let Some(canonical) = result.get_mut("canonical") {
        crate::story_policy::normalize(canonical);
        crate::character_state_policy::normalize(canonical);
        assign_unique_remix_character_state_ids(canonical)?;
        crate::shot_policy::normalize(canonical);
    }
    let canonical_value = result
        .get("canonical")
        .cloned()
        .ok_or_else(|| "二创结果缺少 canonical 对象".to_owned())?;
    let canonical = canonical_value
        .as_object()
        .ok_or_else(|| "二创结果的 canonical 不是对象".to_owned())?;
    let story = canonical
        .get("story")
        .and_then(Value::as_object)
        .ok_or_else(|| "二创结果缺少 story 对象".to_owned())?;
    let title = story
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if title.is_empty() {
        return Err("二创剧情缺少标题".to_owned());
    }
    let story_value = Value::Object(story.clone());
    let synopsis = meaningful_text(&story_value, "synopsis", 40)?;
    let logline = story.get("logline").cloned().unwrap_or_else(|| json!(""));
    let resolved_visual_style = if input.visual_style.trim().is_empty() {
        story
            .get("visual_style")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "AI未生成具体项目画风".to_owned())?
            .to_owned()
    } else {
        input.visual_style.trim().to_owned()
    };

    let characters = required_array(&canonical_value, "characters")?;
    for (index, character) in characters.iter().enumerate() {
        let appearance = character.get("appearance").and_then(Value::as_object);
        if appearance.is_none()
            || ["face", "hair", "body", "clothes", "accessories"]
                .iter()
                .any(|key| {
                    appearance
                        .and_then(|value| value.get(*key))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .is_empty()
                })
        {
            return Err(format!("第{}个角色的 appearance 不是完整对象", index + 1));
        }
        if character
            .get("states")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            return Err(format!("第{}个角色缺少可生图状态", index + 1));
        }
        for (state_index, state) in character
            .get("states")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            for (key, label) in [
                ("name", "状态名称"),
                ("trigger", "出现条件"),
                ("appearance_lock", "外貌锁定"),
                ("clothing_lock", "服装、装备、伤势锁定"),
            ] {
                if state
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
                {
                    return Err(format!(
                        "第{}个角色的第{}个状态缺少{label}",
                        index + 1,
                        state_index + 1
                    ));
                }
            }
        }
    }
    let scenes = required_array(&canonical_value, "scenes")?;
    for (index, scene) in scenes.iter().enumerate() {
        meaningful_text(scene, "description", 15)
            .map_err(|error| format!("第{}个场景：{error}", index + 1))?;
    }
    required_array(&canonical_value, "episodes")?;
    let sequences = required_array(&canonical_value, "sequences")?;
    let sequence_ids = sequences
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let shots = canonical_value
        .get("shots")
        .and_then(Value::as_array)
        .ok_or_else(|| "二创结果缺少 shots 数组".to_owned())?;
    if shots.is_empty() {
        return Err("二创结果没有生成分镜".to_owned());
    }
    let mut shot_durations = Vec::with_capacity(shots.len());
    for (index, shot) in shots.iter().enumerate() {
        let duration = shot.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        if !duration.is_finite() || duration <= 0.0 {
            return Err(format!("第{}个分镜时长不合法：{duration}秒", index + 1));
        }
        meaningful_text(shot, "visual", 12)
            .map_err(|error| format!("第{}个分镜：{error}", index + 1))?;
        meaningful_text(shot, "action", 6)
            .map_err(|error| format!("第{}个分镜：{error}", index + 1))?;
        let sequence_id = shot
            .get("sequence_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !sequence_ids.contains(sequence_id) {
            return Err(format!("第{}个分镜引用了不存在的场次", index + 1));
        }
        shot_durations.push(duration);
    }
    validate_storyboard_durations(
        &shot_durations,
        input.target_duration,
        &input.storyboard_duration_mode,
    )?;
    if !crate::shot_policy::has_spoken_dialogue(&canonical_value) {
        return Err(
            "二创分镜全部缺少具体台词；至少一个分镜必须包含符合剧情的角色对白、独白或旁白"
                .to_owned(),
        );
    }
    normalize_adaptation_note_aliases(&mut result);
    let notes = result
        .get_mut("adaptation_notes")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "二创结果缺少结构、冲突和反转设计说明".to_owned())?;
    for (key, label) in [
        ("source_structure", "结构骨架"),
        ("conflict_design", "冲突升级"),
        ("reversal_design", "反转设计"),
    ] {
        let normalized = normalize_note_list(notes.get(key));
        if normalized.is_empty() {
            return Err(format!("二创结果缺少{label}说明"));
        }
        notes.insert(key.to_owned(), Value::Array(normalized));
    }
    if input.originality == "radical" {
        validate_radical_design(notes)?;
    }
    let originality = notes
        .get("originality_statement")
        .and_then(note_text)
        .ok_or_else(|| "二创结果缺少原创差异说明".to_owned())?;
    notes.insert("originality_statement".to_owned(), json!(originality));
    let result_title = result
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&title)
        .to_owned();
    if let Some(canonical) = result.get_mut("canonical").and_then(Value::as_object_mut) {
        if let Some(story) = canonical.get_mut("story").and_then(Value::as_object_mut) {
            story.insert("aspect_ratio".to_owned(), json!(input.aspect_ratio));
            story.insert("visual_style".to_owned(), json!(resolved_visual_style));
        }
        if let Some(shots) = canonical.get_mut("shots").and_then(Value::as_array_mut) {
            for shot in shots {
                if let Some(object) = shot.as_object_mut() {
                    object.insert("aspect_ratio".to_owned(), json!(input.aspect_ratio));
                    object.insert("visual_style".to_owned(), json!(resolved_visual_style));
                    for (key, fallback) in [
                        ("shot_size", "常规景别"),
                        ("camera_angle", "平视"),
                        ("camera_movement", "固定镜头"),
                        ("scene_lock", ""),
                        ("character_lock", ""),
                        ("visual", "未提供具体画面"),
                        ("action", "未提供具体动作"),
                        ("emotion", ""),
                        ("dialogue", "无"),
                        ("sound", ""),
                        ("image_prompt", ""),
                        ("video_prompt", ""),
                        ("negative_prompt", ""),
                        ("constraints", ""),
                        ("status", "DRAFT"),
                    ] {
                        normalize_object_text_field(object, key, fallback);
                    }
                    object
                        .entry("reference_assets")
                        .or_insert_with(|| json!([]));
                    object.entry("video_assets").or_insert_with(|| json!([]));
                }
            }
        }
    }
    result["title"] = json!(result_title);
    result["logline"] = logline;
    result["synopsis"] = json!(synopsis);
    Ok(result)
}

fn spawn_task(app: tauri::AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let loaded = open(&app).and_then(|connection| {
            connection
                .query_row(
                    "SELECT r.input_json, d.result_json FROM video_remix_tasks r
                     JOIN douyin_understanding_tasks d ON d.id = r.source_task_id
                     WHERE r.id = ?1 AND d.status = 'COMPLETED'",
                    [&task_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
        });
        let (input_json, source_result_json) = match loaded {
            Ok((input, Some(source))) => (input, source),
            Ok((_, None)) => {
                finish_failed(&app, &task_id, "原视频理解任务没有可用结果".to_owned());
                return;
            }
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let input = match serde_json::from_str::<CreateVideoRemixTaskInput>(&input_json) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, format!("二创参数损坏：{error}"));
                return;
            }
        };
        let source_analysis = serde_json::from_str::<Value>(&source_result_json)
            .ok()
            .and_then(|value| value.get("text").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        if source_analysis.trim().is_empty() {
            finish_failed(&app, &task_id, "原视频解析文案为空".to_owned());
            return;
        }
        let mut revision_note: Option<String> = None;
        for attempt in 1..=MAX_GENERATION_ATTEMPTS {
            update_progress(
                &app,
                &task_id,
                0.12 + (attempt as f64 - 1.0) * 0.22,
                &format!("AI正在提炼冲突与反转并创作新剧情（第{attempt}次）"),
            );
            let generated = crate::ai::generate_video_remix(
                &app,
                &source_analysis,
                &input.creative_direction,
                &input.originality,
                &input.storyboard_duration_mode,
                input.target_duration,
                &input.aspect_ratio,
                &input.visual_style,
                &input.language,
                revision_note.as_deref(),
            )
            .await;
            match generated.and_then(|value| validate_result(value, &input)) {
                Ok(result) => {
                    if let (Ok(connection), Ok(result_json)) =
                        (open(&app), serde_json::to_string(&result))
                    {
                        let now = Utc::now().to_rfc3339();
                        let _ = connection.execute(
                            "UPDATE video_remix_tasks SET status = 'COMPLETED', stage = 'completed', progress = 1,
                             message = '二次创作剧情与分镜已生成', result_json = ?2, error_json = NULL,
                             updated_at = ?3, finished_at = ?3 WHERE id = ?1",
                            params![task_id, result_json, now],
                        );
                    }
                    return;
                }
                Err(error) => {
                    if error.contains("CREDIT_CONFIRMATION_CANCELLED") {
                        finish_failed(&app, &task_id, error);
                        return;
                    }
                    revision_note = Some(error);
                },
            }
        }
        finish_failed(
            &app,
            &task_id,
            format!(
                "模型自动重试{MAX_GENERATION_ATTEMPTS}次后仍未生成合格结果：{}",
                revision_note.unwrap_or_else(|| "未知错误".to_owned())
            ),
        );
    });
}

fn validate_input(input: &CreateVideoRemixTaskInput) -> Result<(), String> {
    if input.source_task_id.trim().is_empty() {
        return Err("请选择已完成的视频解析任务".to_owned());
    }
    if input.project_name.trim().is_empty() {
        return Err("请输入二创项目名称".to_owned());
    }
    if input.creative_direction.trim().chars().count() < 4 {
        return Err("二创方向至少需要4个字符".to_owned());
    }
    if !matches!(input.originality.as_str(), "balanced" | "high" | "radical") {
        return Err("二创原创强度无效".to_owned());
    }
    if !matches!(
        input.storyboard_duration_mode.as_str(),
        "fixed" | "adaptive"
    ) {
        return Err("二创分镜时长模式无效".to_owned());
    }
    if !(15.0..=600.0).contains(&input.target_duration) {
        return Err("二创目标时长必须在15～600秒之间".to_owned());
    }
    if !matches!(input.aspect_ratio.as_str(), "9:16" | "16:9") {
        return Err("二创画面比例必须是9:16或16:9".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn create_video_remix_task(
    app: tauri::AppHandle,
    input: CreateVideoRemixTaskInput,
) -> Result<Value, String> {
    validate_input(&input)?;
    let connection = open(&app)?;
    let source_exists = connection
        .query_row(
            "SELECT COUNT(*) FROM douyin_understanding_tasks WHERE id = ?1 AND status = 'COMPLETED' AND result_json IS NOT NULL",
            [&input.source_task_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? > 0;
    if !source_exists {
        return Err("原视频理解任务尚未完成或结果不存在".to_owned());
    }
    let id = format!("REMIX_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO video_remix_tasks (id, source_task_id, project_name, status, stage, progress,
             message, input_json, created_at, updated_at) VALUES (?1, ?2, ?3, 'PENDING', 'queued', 0,
             '已加入二次创作队列', ?4, ?5, ?5)",
            params![id, input.source_task_id, input.project_name, input_json, now],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    spawn_task(app.clone(), id.clone());
    get_task(&app, &id)
}

#[tauri::command]
pub async fn list_video_remix_tasks(
    app: tauri::AppHandle,
    source_task_id: String,
) -> Result<Vec<Value>, String> {
    crate::background::run("读取二次创作任务", move || {
        let connection = open(&app)?;
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_TASK} WHERE source_task_id = ?1 ORDER BY created_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let tasks = statement
            .query_map([source_task_id], task_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub fn retry_video_remix_task(app: tauri::AppHandle, task_id: String) -> Result<Value, String> {
    let connection = open(&app)?;
    let changed = connection
        .execute(
            "UPDATE video_remix_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入二次创作队列', error_json = NULL, finished_at = NULL,
             updated_at = ?2 WHERE id = ?1 AND status = 'FAILED'",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有失败的二次创作任务可以重试".to_owned());
    }
    drop(connection);
    spawn_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn delete_video_remix_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let connection = open(&app)?;
    let changed = connection
        .execute("DELETE FROM video_remix_tasks WHERE id = ?1", [&task_id])
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("二次创作记录不存在".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn create_video_remix_project(
    app: tauri::AppHandle,
    input: CreateVideoRemixProjectInput,
) -> Result<Value, String> {
    if input.root_path.trim().is_empty() || input.project_name.trim().is_empty() {
        return Err("项目名称和项目根目录不能为空".to_owned());
    }
    let connection = open(&app)?;
    let (status, input_json, result_json): (String, String, Option<String>) = connection
        .query_row(
            "SELECT status, input_json, result_json FROM video_remix_tasks WHERE id = ?1",
            [&input.remix_task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "二次创作任务不存在".to_owned())?;
    if status != "COMPLETED" {
        return Err("二次创作尚未完成，不能创建项目".to_owned());
    }
    let remix_input: CreateVideoRemixTaskInput =
        serde_json::from_str(&input_json).map_err(|error| error.to_string())?;
    let result: Value = serde_json::from_str(
        result_json
            .as_deref()
            .ok_or_else(|| "二次创作结果不存在".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let result = validate_result(result, &remix_input)?;
    let mut canonical = result
        .get("canonical")
        .cloned()
        .ok_or_else(|| "二次创作结果缺少项目数据".to_owned())?;
    clear_remix_media_placeholders(&mut canonical);
    let project_visual_style = canonical
        .get("story")
        .and_then(|story| story.get("visual_style"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(remix_input.visual_style.as_str())
        .to_owned();
    let source_text = serde_json::to_string_pretty(&json!({
        "title": result.get("title"),
        "logline": result.get("logline"),
        "synopsis": result.get("synopsis"),
        "adaptation_notes": result.get("adaptation_notes"),
    }))
    .map_err(|error| error.to_string())?;
    let creation_spec = json!({
        "project_name": input.project_name.trim(),
        "input_type": "SCRIPT",
        "target_duration": remix_input.target_duration,
        "aspect_ratio": remix_input.aspect_ratio,
        "content_type": "SHORT_DRAMA",
        "visual_style": project_visual_style,
        "target_platform": "SHORT_VIDEO",
        "language": remix_input.language,
        "creation_mode": "DIRECTOR",
        "source_video_task_id": remix_input.source_task_id,
        "video_remix_task_id": input.remix_task_id,
        "originality": remix_input.originality,
        "storyboard_duration_mode": remix_input.storyboard_duration_mode,
    });
    let bundle = manager::create(manager::CreateProjectInput {
        root_path: input.root_path,
        source_type: "SCRIPT_TEXT".to_owned(),
        source_text: Some(source_text),
        source_path: None,
        creation_spec,
    })?;
    let project_path = bundle
        .get("project")
        .and_then(|value| value.get("project_path"))
        .and_then(Value::as_str)
        .ok_or_else(|| "新项目路径无效".to_owned())?
        .to_owned();
    let project_id = bundle
        .get("project")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "新项目ID无效".to_owned())?
        .to_owned();
    let mut project_connection = crate::database::open(&PathBuf::from(&project_path))?;
    crate::database::repository::save_canonical(&mut project_connection, &project_id, &canonical)?;
    let completed_bundle = crate::database::repository::load_bundle(&project_connection)?;
    registry::register(&app, &completed_bundle, false)?;
    connection
        .execute(
            "UPDATE video_remix_tasks SET project_path = ?2, updated_at = ?3 WHERE id = ?1",
            params![input.remix_task_id, project_path, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(completed_bundle)
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let connection = open(app)?;
    connection
        .execute(
            "UPDATE video_remix_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '应用已恢复二次创作任务', updated_at = ?1 WHERE status = 'RUNNING'",
            [Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id FROM video_remix_tasks WHERE status = 'PENDING'")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);
    for id in ids {
        spawn_task(app.clone(), id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_remix_configuration() {
        let input = CreateVideoRemixTaskInput {
            source_task_id: "TASK_1".to_owned(),
            project_name: "测试".to_owned(),
            creative_direction: "全新都市悬疑故事".to_owned(),
            originality: "copy".to_owned(),
            storyboard_duration_mode: "fixed".to_owned(),
            target_duration: 60.0,
            aspect_ratio: "9:16".to_owned(),
            visual_style: "电影写实".to_owned(),
            language: "zh-CN".to_owned(),
        };
        assert!(validate_input(&input).is_err());
    }

    #[test]
    fn normalizes_string_notes_for_safe_rendering() {
        let normalized = normalize_note_list(Some(&json!("建立目标；冲突升级\n- 结尾反转")));
        assert_eq!(
            Value::Array(normalized),
            json!(["建立目标", "冲突升级", "结尾反转"])
        );
    }

    #[test]
    fn accepts_reversal_aliases_and_keyed_object_items() {
        let mut result = json!({
            "adaptation_notes": {
                "sourceStructure": ["保留原主题并重构事件链"],
                "conflicts": ["公开质疑引爆第一轮冲突"],
                "twists": {
                    "第一次反转": "账本证明被指控者遭到栽赃",
                    "第二次反转": "表面倒戈的盟友实际在引出幕后者"
                },
                "originalityStatement": "人物、场景和事件均已重新设计"
            }
        });
        normalize_adaptation_note_aliases(&mut result);
        let reversals = normalize_note_list(
            result
                .get("adaptation_notes")
                .and_then(|notes| notes.get("reversal_design")),
        );
        assert_eq!(reversals.len(), 2);
        assert!(reversals[0].as_str().unwrap().contains("第一次反转"));
    }

    #[test]
    fn radical_originality_rejects_weak_conflict_or_single_reversal() {
        let notes_value = json!({
            "conflict_design":["主角第一次遭到明确阻拦", "压力继续升级并失去退路"],
            "reversal_design":["真相揭开后目标发生改变"]
        });
        let error = validate_radical_design(notes_value.as_object().unwrap()).unwrap_err();
        assert!(error.contains("至少3个"));
    }

    #[test]
    fn radical_originality_accepts_three_conflicts_and_two_reversals() {
        let notes_value = json!({
            "conflict_design":[
                "BEAT_001：公开指控引爆双方正面对抗",
                "BEAT_002：关键证据被毁导致主角失去退路",
                "BEAT_004：盟友倒戈迫使主角承担重大代价"
            ],
            "reversal_design":[
                "BEAT_003：旧账本证明最初认定的责任人被栽赃",
                "BEAT_005：盟友倒戈实为引出幕后操控者的计划"
            ]
        });
        validate_radical_design(notes_value.as_object().unwrap()).unwrap();
    }

    #[test]
    fn converts_structured_dialogue_to_display_text() {
        assert_eq!(
            note_text(&json!({"character_id": "CHAR_001", "text": "别回头。"})),
            Some("CHAR_001：别回头。".to_owned())
        );
    }

    #[test]
    fn validates_fixed_and_adaptive_storyboard_durations() {
        assert!(validate_storyboard_durations(&[10.0, 10.0, 5.0], 25.0, "fixed").is_ok());
        assert!(validate_storyboard_durations(&[10.0, 8.0, 7.0], 25.0, "fixed").is_err());
        assert!(validate_storyboard_durations(&[8.0, 9.0, 8.0], 25.0, "adaptive").is_ok());
        assert!(validate_storyboard_durations(&[15.0, 10.0, 6.0], 31.0, "adaptive").is_err());
    }

    #[test]
    fn assigns_unique_ids_to_missing_or_duplicate_story_beats() {
        let story = json!({
            "beats": [
                {"id": "", "summary": "开端"},
                {"id": "BEAT_001", "summary": "升级"},
                {"summary": "反转"}
            ]
        });
        let mut canonical = json!({"story": story});
        crate::story_policy::normalize(&mut canonical);
        let story = &canonical["story"];
        let ids = story["beats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|beat| beat["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["BEAT_001", "BEAT_002", "BEAT_003"]);
    }

    #[test]
    fn repairs_shot_sequence_and_scene_references_before_validation() {
        let mut result = json!({
            "canonical": {
                "scenes": [{
                    "id": "scene-a",
                    "name": "天台餐厅"
                }],
                "sequences": [{
                    "id": "sequence-a",
                    "scene_id": "天台餐厅",
                    "shot_ids": ["old-shot"]
                }],
                "shots": [{
                    "id": "old-shot",
                    "sequence_id": "SCENE_001",
                    "scene_id": "scene-a"
                }]
            }
        });
        normalize_remix_structure(&mut result).unwrap();
        let canonical = &result["canonical"];
        assert_eq!(canonical["scenes"][0]["id"], "SCENE_001");
        assert_eq!(canonical["sequences"][0]["id"], "SEQ_001");
        assert_eq!(canonical["sequences"][0]["scene_id"], "SCENE_001");
        assert_eq!(canonical["sequences"][0]["shot_ids"], json!(["SHOT_001"]));
        assert_eq!(canonical["shots"][0]["id"], "SHOT_001");
        assert_eq!(canonical["shots"][0]["sequence_id"], "SEQ_001");
        assert_eq!(canonical["shots"][0]["scene_id"], "SCENE_001");
    }

    #[test]
    fn normalizes_remix_character_state_aliases_and_empty_fields() {
        let mut result = json!({
            "canonical": {
                "characters": [{
                    "id": "CHAR_001",
                    "appearance": {
                        "face": "清瘦长脸，深色眼睛",
                        "hair": "黑色短发",
                        "body": "中等身高，偏瘦",
                        "clothes": "深蓝工作服",
                        "accessories": "工具腰包"
                    },
                    "states": [{
                        "state_name": "受伤状态",
                        "condition": "冲突结束后",
                        "injury_lock": "左臂擦伤并包扎"
                    }]
                }]
            }
        });
        normalize_remix_character_states(&mut result).unwrap();
        let state = &result["canonical"]["characters"][0]["states"][0];
        assert_eq!(state["name"], "受伤状态");
        assert_eq!(state["trigger"], "冲突结束后");
        assert!(state["appearance_lock"].as_str().unwrap().contains("脸部"));
        assert!(state["clothing_lock"]
            .as_str()
            .unwrap()
            .contains("左臂擦伤并包扎"));
        assert!(!state["description"].as_str().unwrap().is_empty());
    }

    #[test]
    fn assigns_unique_character_state_ids_and_repairs_shot_mappings() {
        let mut canonical = json!({
            "characters": [
                {
                    "id": "CHAR_001",
                    "name": "林禾",
                    "states": [{"id": "STATE_001", "name": "质检状态"}]
                },
                {
                    "id": "CHAR_002",
                    "name": "周衡",
                    "states": [{"id": "STATE_001", "name": "管理状态"}]
                }
            ],
            "shots": [{
                "id": "SHOT_001",
                "character_ids": ["CHAR_001", "CHAR_002"],
                "character_state_ids": {
                    "CHAR_001": "STATE_001",
                    "CHAR_002": "STATE_001"
                }
            }]
        });

        assign_unique_remix_character_state_ids(&mut canonical).unwrap();

        assert_eq!(
            canonical["characters"][0]["states"][0]["id"],
            "CHAR_001_STATE_001"
        );
        assert_eq!(
            canonical["characters"][1]["states"][0]["id"],
            "CHAR_002_STATE_001"
        );
        assert_eq!(
            canonical["shots"][0]["character_state_ids"],
            json!({
                "CHAR_001": "CHAR_001_STATE_001",
                "CHAR_002": "CHAR_002_STATE_001"
            })
        );
    }

    #[test]
    fn clears_model_generated_media_placeholders_before_project_save() {
        let mut canonical = json!({
            "characters": [{
                "reference_assets": ["CHAR_001_face_ref"],
                "states": [{"reference_assets": ["CHAR_001_state_ref"]}]
            }],
            "scenes": [{"reference_assets": ["warehouse_concept"]}],
            "shots": [{
                "reference_assets": ["shot_keyframe"],
                "video_assets": ["shot_video"]
            }]
        });

        clear_remix_media_placeholders(&mut canonical);

        assert_eq!(canonical["characters"][0]["reference_assets"], json!([]));
        assert_eq!(
            canonical["characters"][0]["states"][0]["reference_assets"],
            json!([])
        );
        assert_eq!(canonical["scenes"][0]["reference_assets"], json!([]));
        assert_eq!(canonical["shots"][0]["reference_assets"], json!([]));
        assert_eq!(canonical["shots"][0]["video_assets"], json!([]));
    }
}
