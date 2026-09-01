use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
}

fn compact(value: &str) -> String {
    let mut compacted = value
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(
                    character,
                    '，' | '。'
                        | '；'
                        | ';'
                        | ','
                        | '.'
                        | ':'
                        | '：'
                        | '、'
                        | '-'
                        | '_'
                        | '“'
                        | '”'
                )
        })
        .collect::<String>()
        .replace("保持一致", "")
        .replace("固定为", "");
    for non_visual_state_word in [
        "默认状态",
        "常规状态",
        "平静状态",
        "愤怒状态",
        "悲伤状态",
        "开心状态",
        "紧张状态",
        "疲惫状态",
        "受伤状态",
        "状态",
        "情绪",
        "表情",
        "动作",
        "姿势",
        "平静",
        "愤怒",
        "悲伤",
        "开心",
        "紧张",
        "疲惫",
        "受伤",
        "伤势",
    ] {
        compacted = compacted.replace(non_visual_state_word, "");
    }
    compacted
}

fn reference_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(character, '｜' | '|' | '，' | ',' | '：' | ':' | '-' | '_')
        })
        .flat_map(char::to_uppercase)
        .collect()
}

fn collect_reference_values(value: Option<&Value>, output: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::String(value) => {
            let value = value.trim();
            if !value.is_empty() {
                output.push(value.to_owned());
                output.extend(
                    value
                        .split([',', '，', '、', ';', '；', '\n'])
                        .map(str::trim)
                        .filter(|item| !item.is_empty() && *item != value)
                        .map(str::to_owned),
                );
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_reference_values(Some(value), output);
            }
        }
        Value::Object(object) => {
            let before = output.len();
            for key in ["character_id", "characterId", "id", "name"] {
                if let Some(value) = object.get(key).and_then(Value::as_str) {
                    output.push(value.to_owned());
                }
            }
            // Some providers return an object keyed by character ID instead of an array.
            if output.len() == before {
                output.extend(object.keys().cloned());
            }
        }
        _ => {}
    }
}

fn normalize_character_ids(
    value: Option<&Value>,
    aliases: &HashMap<String, String>,
) -> Vec<String> {
    let mut candidates = Vec::new();
    collect_reference_values(value, &mut candidates);
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|candidate| aliases.get(&reference_key(&candidate)).cloned())
        .filter(|character_id| seen.insert(character_id.clone()))
        .collect()
}

fn add_state_mapping(
    mappings: &mut Map<String, Value>,
    character_value: &str,
    state_value: &str,
    character_aliases: &HashMap<String, String>,
    state_aliases: &HashMap<String, HashMap<String, String>>,
    defaults: &HashMap<String, String>,
) {
    let Some(character_id) = character_aliases
        .get(&reference_key(character_value))
        .cloned()
    else {
        return;
    };
    let state_id = state_aliases
        .get(&character_id)
        .and_then(|aliases| aliases.get(&reference_key(state_value)))
        .or_else(|| defaults.get(&character_id));
    if let Some(state_id) = state_id {
        mappings.insert(character_id, json!(state_id));
    }
}

fn collect_state_mappings(
    value: Option<&Value>,
    mappings: &mut Map<String, Value>,
    character_aliases: &HashMap<String, String>,
    state_aliases: &HashMap<String, HashMap<String, String>>,
    defaults: &HashMap<String, String>,
) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(values) => {
            for value in values {
                collect_state_mappings(
                    Some(value),
                    mappings,
                    character_aliases,
                    state_aliases,
                    defaults,
                );
            }
        }
        Value::Object(object) => {
            if let (Some(character_id), Some(state_id)) = (
                object
                    .get("character_id")
                    .or_else(|| object.get("characterId"))
                    .and_then(Value::as_str),
                object
                    .get("state_id")
                    .or_else(|| object.get("stateId"))
                    .or_else(|| object.get("id"))
                    .and_then(Value::as_str),
            ) {
                add_state_mapping(
                    mappings,
                    character_id,
                    state_id,
                    character_aliases,
                    state_aliases,
                    defaults,
                );
                return;
            }
            for (character_id, state_id) in object {
                if let Some(state_id) = state_id.as_str() {
                    add_state_mapping(
                        mappings,
                        character_id,
                        state_id,
                        character_aliases,
                        state_aliases,
                        defaults,
                    );
                }
            }
        }
        Value::String(value) => {
            for entry in value.split([',', '，', '、', ';', '；', '\n']) {
                let entry = entry.trim();
                let pair = entry
                    .split_once(':')
                    .or_else(|| entry.split_once('：'))
                    .or_else(|| entry.split_once('|'))
                    .or_else(|| entry.split_once('｜'));
                if let Some((character_id, state_id)) = pair {
                    add_state_mapping(
                        mappings,
                        character_id,
                        state_id,
                        character_aliases,
                        state_aliases,
                        defaults,
                    );
                }
            }
        }
        _ => {}
    }
}

fn normalize_character_references(
    value: &mut Value,
    character_aliases: &HashMap<String, String>,
    inference_aliases: &[(String, String)],
    state_aliases: &HashMap<String, HashMap<String, String>>,
    defaults: &HashMap<String, String>,
) {
    if let Some(sequences) = value.get_mut("sequences").and_then(Value::as_array_mut) {
        for sequence in sequences {
            let Some(sequence) = sequence.as_object_mut() else {
                continue;
            };
            let mut character_ids =
                normalize_character_ids(sequence.get("character_ids"), character_aliases);
            if character_ids.is_empty() {
                let summary = sequence
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                for (alias, character_id) in inference_aliases {
                    if !alias.is_empty()
                        && reference_key(summary).contains(alias)
                        && !character_ids.contains(character_id)
                    {
                        character_ids.push(character_id.clone());
                    }
                }
            }
            sequence.insert("character_ids".to_owned(), json!(character_ids));
        }
    }

    let Some(shots) = value.get_mut("shots").and_then(Value::as_array_mut) else {
        return;
    };
    for shot in shots {
        let Some(shot) = shot.as_object_mut() else {
            continue;
        };
        let mut mappings = Map::new();
        collect_state_mappings(
            shot.get("character_state_ids"),
            &mut mappings,
            character_aliases,
            state_aliases,
            defaults,
        );
        let mut character_ids =
            normalize_character_ids(shot.get("character_ids"), character_aliases);
        for character_id in mappings.keys() {
            if !character_ids.contains(character_id) {
                character_ids.push(character_id.clone());
            }
        }
        if character_ids.is_empty() {
            let context = ["visual", "action", "dialogue", "character_lock"]
                .iter()
                .filter_map(|key| shot.get(*key).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            let context = reference_key(&context);
            for (alias, character_id) in inference_aliases {
                if !alias.is_empty()
                    && context.contains(alias)
                    && !character_ids.contains(character_id)
                {
                    character_ids.push(character_id.clone());
                }
            }
        }
        for character_id in &character_ids {
            if !mappings.contains_key(character_id) {
                if let Some(state_id) = defaults.get(character_id) {
                    mappings.insert(character_id.clone(), json!(state_id));
                }
            }
        }
        mappings.retain(|character_id, _| character_ids.contains(character_id));
        shot.insert("character_ids".to_owned(), json!(character_ids));
        shot.insert("character_state_ids".to_owned(), Value::Object(mappings));
    }
}

fn age_signature(value: &str) -> String {
    if ["婴儿", "幼年", "孩童", "儿童"]
        .iter()
        .any(|word| value.contains(word))
    {
        return "child".to_owned();
    }
    if value.contains("少年") {
        return "teen".to_owned();
    }
    if ["青年", "年轻"].iter().any(|word| value.contains(word)) {
        return "young".to_owned();
    }
    if value.contains("中年") {
        return "middle".to_owned();
    }
    if ["老年", "年老", "暮年"]
        .iter()
        .any(|word| value.contains(word))
    {
        return "senior".to_owned();
    }
    if value.contains("成年") {
        return "adult".to_owned();
    }
    let chars = value.chars().collect::<Vec<_>>();
    for (index, character) in chars.iter().enumerate() {
        if *character != '岁' {
            continue;
        }
        let digits = chars[..index]
            .iter()
            .rev()
            .take_while(|character| character.is_ascii_digit())
            .copied()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        if let Ok(age) = digits.parse::<u8>() {
            return match age {
                0..=12 => "child",
                13..=17 => "teen",
                18..=35 => "young",
                36..=59 => "middle",
                _ => "senior",
            }
            .to_owned();
        }
    }
    String::new()
}

fn has_wearable_or_prop(value: &str) -> bool {
    [
        "衣", "裤", "裙", "鞋", "袜", "帽", "盔", "甲", "服", "外套", "夹克", "衬衫", "装束",
        "穿着", "披风", "腰带", "首饰", "配饰", "眼镜", "面具", "手套", "包", "箱", "剑", "刀",
        "枪", "杖", "伞", "道具", "装备", "武器", "工具",
    ]
    .into_iter()
    .any(|keyword| value.contains(keyword))
}

fn wearable_signature(value: &str) -> String {
    let clauses = value
        .split(['；', ';', '\n', '。'])
        .map(str::trim)
        .filter(|clause| !clause.is_empty())
        .filter(|clause| {
            has_wearable_or_prop(clause)
                || ![
                    "情绪", "表情", "动作", "姿势", "地点", "场景", "受伤", "伤势", "疲惫", "愤怒",
                    "悲伤", "开心", "紧张",
                ]
                .into_iter()
                .any(|keyword| clause.contains(keyword))
        })
        .map(|clause| {
            // “办公室状态/愤怒状态/神变状态”等前缀只是标签，状态签名只比较
            // 后面真正的服装、道具与装备描述。
            let visual_clause = clause
                .split_once("状态")
                .map(|(_, visual)| visual)
                .unwrap_or(clause);
            compact(visual_clause)
        })
        .filter(|clause| !clause.is_empty())
        .collect::<Vec<_>>();
    clauses.join("|")
}

fn state_signature(state: &Map<String, Value>, base_clothing: &str) -> String {
    let combined = format!(
        "{}；{}；{}；{}",
        text(state, "name"),
        text(state, "description"),
        text(state, "appearance_lock"),
        text(state, "clothing_lock")
    );
    let clothing = if text(state, "clothing_lock").is_empty() {
        wearable_signature(base_clothing)
    } else {
        wearable_signature(text(state, "clothing_lock"))
    };
    // 道具与装备属于 clothing_lock 的锁定范围。不要把 description/name 纳入
    // 服装签名，否则“平静/愤怒”等非视觉形态词会被误判为不同状态。
    format!("age:{}|wear:{}", age_signature(&combined), clothing)
}

fn normalize_character(
    character: &mut Map<String, Value>,
    character_index: usize,
) -> HashMap<String, String> {
    let character_id = text(character, "id").to_owned();
    let character_id = if character_id.is_empty() {
        format!("CHAR_{:03}", character_index + 1)
    } else {
        character_id
    };
    character.insert("id".to_owned(), json!(character_id.clone()));
    let appearance_lock = text(character, "appearance_lock").to_owned();
    let appearance_lock = if appearance_lock.is_empty() {
        character
            .get("appearance")
            .and_then(Value::as_object)
            .and_then(|appearance| appearance.get("face"))
            .and_then(Value::as_str)
            .unwrap_or("五官、发型和体态保持一致")
            .to_owned()
    } else {
        appearance_lock
    };
    let clothing_lock = text(character, "clothing_lock").to_owned();
    let clothing_lock = if clothing_lock.is_empty() {
        character
            .get("appearance")
            .and_then(Value::as_object)
            .and_then(|appearance| appearance.get("clothes"))
            .and_then(Value::as_str)
            .unwrap_or("服装与道具保持一致")
            .to_owned()
    } else {
        clothing_lock
    };
    let mut states = character
        .remove("states")
        .and_then(|states| states.as_array().cloned())
        .unwrap_or_default();
    if states.is_empty() {
        states.push(json!({}));
    }

    let mut redirects = HashMap::new();
    let mut signature_to_index = HashMap::<String, usize>::new();
    let mut kept = Vec::<Value>::new();
    for (state_index, mut state) in states.into_iter().enumerate() {
        if !state.is_object() {
            state = json!({});
        }
        let state_object = state.as_object_mut().expect("state normalized to object");
        let old_id = text(state_object, "id").to_owned();
        let state_id = if old_id.is_empty() {
            format!("{}_STATE_{:03}", character_id, state_index + 1)
        } else {
            old_id.clone()
        };
        state_object.insert("id".to_owned(), json!(state_id.clone()));
        if text(state_object, "name").is_empty() {
            state_object.insert(
                "name".to_owned(),
                json!(if state_index == 0 {
                    "默认状态".to_owned()
                } else {
                    format!("状态{}", state_index + 1)
                }),
            );
        }
        if text(state_object, "trigger").is_empty() {
            state_object.insert("trigger".to_owned(), json!("角色常规出场时"));
        }
        if text(state_object, "appearance_lock").is_empty() {
            state_object.insert("appearance_lock".to_owned(), json!(appearance_lock.clone()));
        }
        if text(state_object, "clothing_lock").is_empty() {
            state_object.insert("clothing_lock".to_owned(), json!(clothing_lock.clone()));
        }
        if text(state_object, "description").is_empty() {
            let description = format!(
                "{}；{}",
                text(state_object, "appearance_lock"),
                text(state_object, "clothing_lock")
            );
            state_object.insert("description".to_owned(), json!(description));
        }
        state_object
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        state_object.entry("locked").or_insert_with(|| json!(false));

        let signature = state_signature(state_object, &clothing_lock);
        if let Some(existing_index) = signature_to_index.get(&signature).copied() {
            let existing_id = kept[existing_index]
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            redirects.insert(state_id, existing_id);
        } else {
            signature_to_index.insert(signature, kept.len());
            redirects.insert(state_id.clone(), state_id);
            kept.push(state);
        }
    }
    character.insert("states".to_owned(), Value::Array(kept));
    redirects
}

pub fn normalize(value: &mut Value) {
    let Some(characters) = value.get_mut("characters").and_then(Value::as_array_mut) else {
        return;
    };
    let mut character_aliases = HashMap::<String, String>::new();
    let mut inference_aliases = Vec::<(String, String)>::new();
    let mut state_aliases = HashMap::<String, HashMap<String, String>>::new();
    let mut defaults = HashMap::<String, String>::new();
    for (index, character) in characters.iter_mut().enumerate() {
        let Some(character) = character.as_object_mut() else {
            continue;
        };
        let original_character_id = text(character, "id").to_owned();
        let character_name = text(character, "name").to_owned();
        let character_redirects = normalize_character(character, index);
        let character_id = text(character, "id").to_owned();
        for alias in [&original_character_id, &character_id, &character_name] {
            if !alias.trim().is_empty() {
                character_aliases.insert(reference_key(alias), character_id.clone());
            }
        }
        if !character_name.trim().is_empty() {
            inference_aliases.push((reference_key(&character_name), character_id.clone()));
        }
        let aliases = state_aliases.entry(character_id.clone()).or_default();
        if let Some(states) = character.get("states").and_then(Value::as_array) {
            for state in states {
                let state_id = state.get("id").and_then(Value::as_str).unwrap_or_default();
                let state_name = state
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                for alias in [state_id, state_name] {
                    if !alias.trim().is_empty() {
                        aliases.insert(reference_key(alias), state_id.to_owned());
                    }
                }
            }
        }
        if let Some(default_id) = character
            .get("states")
            .and_then(Value::as_array)
            .and_then(|states| states.first())
            .and_then(|state| state.get("id"))
            .and_then(Value::as_str)
        {
            defaults.insert(character_id.clone(), default_id.to_owned());
        }
        for (from, to) in character_redirects {
            aliases.insert(reference_key(&from), to);
        }
    }
    normalize_character_references(
        value,
        &character_aliases,
        &inference_aliases,
        &state_aliases,
        &defaults,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_emotion_only_states_and_repairs_shot_reference() {
        let mut canonical = json!({
            "characters": [{
                "id":"CHAR_001",
                "appearance":{"face":"年轻男性", "clothes":"深蓝夹克"},
                "states":[
                    {"id":"S1","name":"平静状态","appearance_lock":"年轻男性","clothing_lock":"深蓝夹克"},
                    {"id":"S2","name":"愤怒状态","appearance_lock":"年轻男性，愤怒表情","clothing_lock":"深蓝夹克"}
                ]
            }],
            "shots":[{"character_state_ids":{"CHAR_001":"S2"}}]
        });
        normalize(&mut canonical);
        assert_eq!(
            canonical["characters"][0]["states"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            canonical["shots"][0]["character_state_ids"]["CHAR_001"],
            "S1"
        );
    }

    #[test]
    fn keeps_states_with_clear_clothing_prop_or_age_changes() {
        let mut canonical = json!({
            "characters": [{
                "id":"CHAR_001",
                "appearance":{"face":"东方男性", "clothes":"深蓝夹克"},
                "states":[
                    {"id":"S1","name":"年轻状态","appearance_lock":"年轻男性","clothing_lock":"深蓝夹克，手提保温箱"},
                    {"id":"S2","name":"老年状态","appearance_lock":"老年男性","clothing_lock":"灰色长衫，手持拐杖"},
                    {"id":"S3","name":"战斗状态","appearance_lock":"年轻男性","clothing_lock":"金色战甲，手持长棍"}
                ]
            }]
        });
        normalize(&mut canonical);
        assert_eq!(
            canonical["characters"][0]["states"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn collapses_location_labels_when_the_visible_design_is_unchanged() {
        let mut canonical = json!({
            "characters": [{
                "id":"CHAR_001",
                "appearance":{"face":"中年女性", "clothes":"灰色工作服"},
                "states":[
                    {"id":"S1","name":"办公室状态","appearance_lock":"中年女性，神情平静","clothing_lock":"办公室状态固定为灰色工作服，手持记录板"},
                    {"id":"S2","name":"车间状态","appearance_lock":"中年女性，神情紧张","clothing_lock":"车间状态固定为灰色工作服，手持记录板"}
                ]
            }]
        });
        normalize(&mut canonical);
        assert_eq!(
            canonical["characters"][0]["states"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn repairs_remix_array_state_references_and_missing_character_ids() {
        let mut canonical = json!({
            "characters": [
                {
                    "id":"CHAR_001",
                    "name":"沈禾",
                    "appearance":{"face":"青年女性", "clothes":"记者外套"},
                    "states":[{"id":"STATE_001","name":"采访状态","appearance_lock":"青年女性","clothing_lock":"记者外套，手持采访麦克风"}]
                },
                {
                    "id":"CHAR_002",
                    "name":"周桂枝",
                    "appearance":{"face":"老年女性", "clothes":"旧工作服"},
                    "states":[{"id":"STATE_002","name":"劳作状态","appearance_lock":"老年女性","clothing_lock":"旧工作服，手持粮袋"}]
                }
            ],
            "sequences":[{"id":"SEQ_001","summary":"沈禾采访周桂枝"}],
            "shots":[{
                "id":"SHOT_001",
                "visual":"沈禾举起麦克风，周桂枝站在粮仓前",
                "character_state_ids":["CHAR_001:STATE_001", "CHAR_002:STATE_002"]
            }]
        });
        normalize(&mut canonical);
        assert_eq!(
            canonical["sequences"][0]["character_ids"],
            json!(["CHAR_001", "CHAR_002"])
        );
        assert_eq!(
            canonical["shots"][0]["character_ids"],
            json!(["CHAR_001", "CHAR_002"])
        );
        assert_eq!(
            canonical["shots"][0]["character_state_ids"],
            json!({"CHAR_001":"STATE_001", "CHAR_002":"STATE_002"})
        );
    }

    #[test]
    fn repairs_scalar_and_object_character_references() {
        let mut canonical = json!({
            "characters": [{
                "id":"CHAR_001",
                "name":"林岚",
                "appearance":{"face":"中年女性", "clothes":"工作服"},
                "states":[{"id":"S1","name":"默认状态","appearance_lock":"中年女性","clothing_lock":"工作服"}]
            }],
            "sequences":[{"id":"SEQ_001","character_ids":"林岚"}],
            "shots":[{
                "id":"SHOT_001",
                "character_ids":{"character_id":"CHAR_001", "text":"林岚"},
                "character_state_ids":[{"character_id":"CHAR_001", "state_id":"S1"}]
            }]
        });
        normalize(&mut canonical);
        assert_eq!(
            canonical["sequences"][0]["character_ids"],
            json!(["CHAR_001"])
        );
        assert_eq!(canonical["shots"][0]["character_ids"], json!(["CHAR_001"]));
        assert!(canonical["shots"][0]["character_state_ids"].is_object());
    }
}
