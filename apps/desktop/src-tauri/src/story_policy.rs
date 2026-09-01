use serde_json::{json, Value};

fn beat_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_owned()),
        Value::Object(object) => ["description", "content", "summary", "text", "name", "title"]
            .iter()
            .filter_map(|key| object.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_owned),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

/// Normalizes provider-specific story beat shapes into the canonical object form.
/// In particular, models commonly return an array of strings, which previously
/// produced repeated empty database IDs when a remix was saved as a project.
pub(crate) fn normalize(canonical: &mut Value) {
    let Some(story) = canonical.get_mut("story").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(beats) = story.get_mut("beats").and_then(Value::as_array_mut) else {
        return;
    };
    for (index, beat) in beats.iter_mut().enumerate() {
        let description = beat_text(beat).unwrap_or_else(|| format!("剧情节点{}", index + 1));
        if !beat.is_object() {
            *beat = json!({});
        }
        let beat = beat
            .as_object_mut()
            .expect("story beat normalized to object");
        beat.insert("id".to_owned(), json!(format!("BEAT_{:03}", index + 1)));
        if beat
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            beat.insert("type".to_owned(), json!("story"));
        }
        if beat
            .get("description")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            beat.insert("description".to_owned(), json!(description));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_string_beats_and_reassigns_unique_ids() {
        let mut canonical = json!({
            "story": {
                "beats": [
                    "测量员发现冻土沉降。",
                    {"id":"BEAT_001", "content":"施工队重新测量并加固。"},
                    {"id":"BEAT_001", "description":"校车安全通过。"}
                ]
            }
        });
        normalize(&mut canonical);
        assert_eq!(canonical["story"]["beats"][0]["id"], "BEAT_001");
        assert_eq!(canonical["story"]["beats"][1]["id"], "BEAT_002");
        assert_eq!(canonical["story"]["beats"][2]["id"], "BEAT_003");
        assert_eq!(
            canonical["story"]["beats"][0]["description"],
            "测量员发现冻土沉降。"
        );
        assert!(canonical["story"]["beats"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_object));
    }
}
