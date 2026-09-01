use serde_json::{json, Value};

fn is_empty_dialogue(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "无" | "无台词" | "无对白" | "none" | "null" | "n/a" | "-" | "—"
    )
}

fn quoted_dialogue(value: &str) -> String {
    let value = value.trim();
    if value.starts_with(['“', '‘', '"']) {
        value.to_owned()
    } else {
        format!("“{value}”")
    }
}

fn dialogue_visual_entry(value: &str) -> Option<(String, String)> {
    let mut value = value
        .trim()
        .trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, '-' | '*' | '•')
                || character.is_ascii_digit()
                || matches!(character, '.' | '、')
        })
        .trim();
    while let Some(stripped) = value
        .strip_prefix("台词：")
        .or_else(|| value.strip_prefix("台词:"))
        .or_else(|| value.strip_prefix("对白："))
        .or_else(|| value.strip_prefix("对白:"))
        .or_else(|| value.strip_prefix("口播台词："))
        .or_else(|| value.strip_prefix("口播台词:"))
    {
        value = stripped.trim();
    }
    if is_empty_dialogue(value) {
        return None;
    }
    let Some((speaker, content)) = value.split_once('：').or_else(|| value.split_once(':')) else {
        return Some((value.to_owned(), value.to_owned()));
    };
    let content = content.trim();
    let plain_content = content
        .trim_matches(|character| {
            matches!(
                character,
                '“' | '”' | '‘' | '’' | '"' | '\'' | '。' | '.' | '；' | ';'
            )
        })
        .trim();
    if is_empty_dialogue(plain_content) {
        return None;
    }
    let speaker = speaker.trim();
    let visual_speaker = if speaker.contains('说') || speaker.contains("旁白") {
        speaker.to_owned()
    } else if let Some((name, emotion)) = speaker.split_once('（') {
        format!("{}说（{}", name.trim(), emotion.trim())
    } else {
        format!("{speaker}说")
    };
    Some((
        format!("{visual_speaker}：{}", quoted_dialogue(content)),
        plain_content.to_owned(),
    ))
}

fn dialogue_visual_entries(value: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for line in value.lines() {
        let parts = line
            .split(['；', ';'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let structured_parts = parts
            .iter()
            .filter(|part| part.contains('：') || part.contains(':'))
            .count();
        if structured_parts >= 2 {
            entries.extend(parts.into_iter().filter_map(dialogue_visual_entry));
        } else if let Some(entry) = dialogue_visual_entry(line) {
            entries.push(entry);
        }
    }
    entries
}

fn append_dialogue_to_visual(visual: &str, dialogue: &str) -> String {
    let additions = dialogue_visual_entries(dialogue)
        .into_iter()
        .filter(|(_, content)| !visual.contains(content))
        .map(|(entry, _)| entry)
        .collect::<Vec<_>>();
    if additions.is_empty() {
        visual.to_owned()
    } else if visual.trim().is_empty() {
        additions.join("\n")
    } else {
        format!("{}\n{}", visual.trim_end(), additions.join("\n"))
    }
}

fn dialogue_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_owned()),
        Value::Array(values) => {
            let lines = values.iter().filter_map(dialogue_text).collect::<Vec<_>>();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        Value::Object(object) => {
            let content = object
                .get("text")
                .or_else(|| object.get("dialogue"))
                .or_else(|| object.get("content"))
                .and_then(dialogue_text)?;
            let speaker = object
                .get("character_name")
                .or_else(|| object.get("character_id"))
                .or_else(|| object.get("speaker"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|speaker| !speaker.is_empty());
            Some(match speaker {
                Some(speaker) => format!("{speaker}：{content}"),
                None => content,
            })
        }
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

pub(crate) fn prompt_section(prompt: &str, label: &str) -> Option<String> {
    let markers = [
        "运镜：",
        "画面：",
        "动作：",
        "台词：",
        "对白：",
        "声音：",
        "音效：",
        "约束：",
        "场景参考图：",
        "角色参考图：",
        "项目画风：",
        "画风：",
    ];
    let start_marker = format!("{label}：");
    let start = prompt.find(&start_marker)? + start_marker.len();
    let remaining = &prompt[start..];
    let end = markers
        .iter()
        .filter(|marker| **marker != start_marker)
        .filter_map(|marker| remaining.find(marker))
        .min()
        .unwrap_or(remaining.len());
    let value = remaining[..end]
        .trim()
        .trim_matches(|character| matches!(character, ';' | '；' | '\n' | '\r' | ' '))
        .trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Keeps the independently editable storyboard fields in sync with model-generated
/// video prompts. Some providers put dialogue only inside the "台词：" prompt section.
pub(crate) fn normalize(canonical: &mut Value) {
    let Some(shots) = canonical.get_mut("shots").and_then(Value::as_array_mut) else {
        return;
    };
    for shot in shots {
        let Some(shot) = shot.as_object_mut() else {
            continue;
        };
        let dialogue = shot
            .get("dialogue")
            .and_then(dialogue_text)
            .filter(|dialogue| !is_empty_dialogue(dialogue))
            .or_else(|| {
                let prompt = shot
                    .get("video_prompt")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                prompt_section(prompt, "台词")
                    .or_else(|| prompt_section(prompt, "对白"))
                    .filter(|value| !is_empty_dialogue(value))
            });
        if let Some(dialogue) = dialogue {
            shot.insert("dialogue".to_owned(), json!(dialogue.clone()));
            let visual = shot
                .get("visual")
                .and_then(Value::as_str)
                .unwrap_or_default();
            shot.insert(
                "visual".to_owned(),
                json!(append_dialogue_to_visual(visual, &dialogue)),
            );
        }
    }
}

fn is_storyboard_field(line: &str, labels: &[&str]) -> bool {
    let line = line.trim_start();
    labels.iter().any(|label| {
        line.starts_with(&format!("{label}：")) || line.starts_with(&format!("{label}:"))
    })
}

fn field_inline_value<'a>(line: &'a str, labels: &[&str]) -> &'a str {
    let line = line.trim_start();
    labels
        .iter()
        .find_map(|label| {
            line.strip_prefix(&format!("{label}："))
                .or_else(|| line.strip_prefix(&format!("{label}:")))
        })
        .unwrap_or_default()
        .trim()
}

/// Video-link and local-video understanding return a structured plain-text
/// storyboard. Copy each spoken line into that shot's visual field while
/// retaining the independently editable dialogue field.
pub(crate) fn internalize_storyboard_dialogue_in_visual(script: &str) -> String {
    let lines = script.lines().collect::<Vec<_>>();
    let mut output = Vec::<String>::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        if !is_storyboard_field(lines[index], &["画面"]) {
            output.push(lines[index].to_owned());
            index += 1;
            continue;
        }
        let visual_start = index;
        let mut dialogue_start = index + 1;
        while dialogue_start < lines.len()
            && !is_storyboard_field(lines[dialogue_start], &["口播台词", "台词"])
            && !is_storyboard_field(lines[dialogue_start], &["动作", "声音", "约束"])
            && !lines[dialogue_start].trim_start().starts_with('第')
        {
            dialogue_start += 1;
        }
        if dialogue_start >= lines.len()
            || !is_storyboard_field(lines[dialogue_start], &["口播台词", "台词"])
        {
            output.push(lines[index].to_owned());
            index += 1;
            continue;
        }
        let mut dialogue_end = dialogue_start + 1;
        while dialogue_end < lines.len()
            && !is_storyboard_field(lines[dialogue_end], &["动作", "声音", "约束"])
            && !lines[dialogue_end].trim_start().starts_with('第')
        {
            dialogue_end += 1;
        }
        let mut dialogue_lines = Vec::new();
        let inline = field_inline_value(lines[dialogue_start], &["口播台词", "台词"]);
        if !inline.is_empty() {
            dialogue_lines.push(inline);
        }
        dialogue_lines.extend(lines[dialogue_start + 1..dialogue_end].iter().copied());
        let visual_block = lines[visual_start..dialogue_start].join("\n");
        let additions = dialogue_visual_entries(&dialogue_lines.join("\n"))
            .into_iter()
            .filter(|(_, content)| !visual_block.contains(content))
            .map(|(entry, _)| entry)
            .collect::<Vec<_>>();
        output.extend(
            lines[visual_start..dialogue_start]
                .iter()
                .map(|line| (*line).to_owned()),
        );
        output.extend(additions);
        index = dialogue_start;
    }
    let mut result = output.join("\n");
    if script.ends_with('\n') {
        result.push('\n');
    }
    result
}

pub(crate) fn has_spoken_dialogue(canonical: &Value) -> bool {
    canonical
        .get("shots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|shot| shot.get("dialogue"))
        .filter_map(|dialogue| dialogue.as_str())
        .any(|dialogue| !is_empty_dialogue(dialogue))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_dialogue_from_single_line_video_prompt() {
        let prompt = "运镜：缓慢推进；画面：两人站在粮仓前；动作：记者举起麦克风；台词：沈禾说“是谁守住了我们的饭碗？”，周桂枝说“是种地的人。”；声音：风声和同期声；约束：无字幕；项目画风：纪实电影风";
        assert_eq!(
            prompt_section(prompt, "台词"),
            Some("沈禾说“是谁守住了我们的饭碗？”，周桂枝说“是种地的人。”".to_owned())
        );
    }

    #[test]
    fn repairs_missing_dialogue_without_overwriting_explicit_dialogue() {
        let mut canonical = json!({
            "shots": [
                {"dialogue":"无", "video_prompt":"运镜：固定；台词：林岚说“现在开始。”；声音：环境声"},
                {"dialogue":"周禾：保留我。", "video_prompt":"台词：不应覆盖；声音：环境声"}
            ]
        });
        normalize(&mut canonical);
        assert_eq!(canonical["shots"][0]["dialogue"], "林岚说“现在开始。”");
        assert_eq!(canonical["shots"][1]["dialogue"], "周禾：保留我。");
        assert!(canonical["shots"][0]["visual"]
            .as_str()
            .unwrap()
            .contains("林岚说“现在开始。”"));
        assert!(canonical["shots"][1]["visual"]
            .as_str()
            .unwrap()
            .contains("周禾说：“保留我。”"));
        assert!(has_spoken_dialogue(&canonical));
    }

    #[test]
    fn internalizes_plain_text_storyboard_dialogue_without_duplication() {
        let script = "第1段（0～10秒）\n画面：林禾站在检测台前，周衡隔桌而立。\n口播台词：\n- 林禾（坚定）：\"这批粮不能降级。\"\n- 周衡（冷淡）：\"合同已经生效。\"\n动作：林禾按住合同。\n\n第2段（10～20秒）\n画面：0～5秒：林禾说（坚定）：\"证据就在这里。\"\n口播台词：\n- 林禾（坚定）：\"证据就在这里。\"\n动作：林禾举起检测报告。";
        let normalized = internalize_storyboard_dialogue_in_visual(script);
        assert!(normalized.contains("林禾说（坚定）：\"这批粮不能降级。\""));
        assert!(normalized.contains("周衡说（冷淡）：\"合同已经生效。\""));
        assert_eq!(normalized.matches("证据就在这里").count(), 2);
        assert!(normalized.contains("口播台词：\n- 林禾（坚定）"));
    }

    #[test]
    fn internalizes_nested_and_same_line_multi_speaker_dialogue() {
        let mut canonical = json!({
            "shots": [{
                "visual": "两人在粮仓检测台两侧对峙。",
                "dialogue": "周衡：“今天只能半价收。”\n台词：林禾：“假数据不能签。”；老赵：“原始记录还在。”"
            }]
        });
        normalize(&mut canonical);
        let visual = canonical["shots"][0]["visual"].as_str().unwrap();
        assert!(visual.contains("周衡说：“今天只能半价收。”"));
        assert!(visual.contains("林禾说：“假数据不能签。”"));
        assert!(visual.contains("老赵说：“原始记录还在。”"));
        assert!(!visual.contains("台词说"));
    }
}
