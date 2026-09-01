use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf};

use crate::{database, jobs};

const DEFAULT_CHUNK_SECONDS: f64 = 90.0;

pub async fn develop(
    app: &tauri::AppHandle,
    project_path: PathBuf,
    project_id: String,
    idea: String,
    creation_spec: Value,
) -> Result<Value, String> {
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(600.0)
        .clamp(181.0, 3600.0);
    let chunk_duration = creation_spec
        .get("long_form_chunk_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_CHUNK_SECONDS)
        .clamp(60.0, 90.0);
    let connection = database::open(&project_path)?;
    let existing = database::idea_workflows::latest(&connection, &project_id)?
        .filter(|workflow| workflow.status != "COMPLETED");
    let workflow = if let Some(workflow) = existing {
        let mut resume_snapshot = workflow.snapshot.clone();
        let approving_outline = workflow.status == "WAITING_INPUT";
        if approving_outline {
            resume_snapshot["outline_approved"] = json!(true);
        }
        database::idea_workflows::update(
            &connection,
            &workflow.id,
            "RUNNING",
            &workflow.stage,
            workflow.progress,
            if approving_outline {
                "大纲已确认，准备顺序生成分镜"
            } else {
                "正在从上次完成位置继续长篇创作"
            },
            &resume_snapshot,
            None,
        )?
    } else {
        database::idea_workflows::create(&connection, &project_id, target_duration, chunk_duration)?
    };
    let job_id = jobs::create(
        &connection,
        &project_id,
        "DEVELOP_LONG_IDEA",
        &json!({"idea": idea, "creation_spec": creation_spec, "workflow_id": workflow.id}),
    )?;
    jobs::update(
        &connection,
        &job_id,
        "RUNNING",
        workflow.progress,
        Some(&workflow.stage),
        Some(&workflow.message),
    )?;
    drop(connection);

    let mut snapshot = workflow.snapshot.clone();
    let result = execute(
        app,
        &project_path,
        &project_id,
        &job_id,
        &workflow.id,
        &idea,
        &creation_spec,
        target_duration,
        chunk_duration,
        &mut snapshot,
    )
    .await;
    if let Err(message) = &result {
        let error_value = serde_json::from_str(message).unwrap_or_else(
            |_| json!({"code":"LONG_IDEA_WORKFLOW_ERROR","message":message,"retryable":true}),
        );
        if let Ok(connection) = database::open(&project_path) {
            let failed_stage = database::idea_workflows::get(&connection, &workflow.id)
                .ok()
                .flatten()
                .map(|current| current.stage)
                .unwrap_or_else(|| workflow.stage.clone());
            let _ = database::idea_workflows::update(
                &connection,
                &workflow.id,
                "FAILED",
                &failed_stage,
                workflow_progress(&snapshot),
                error_value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("长篇创作失败"),
                &snapshot,
                Some(&error_value),
            );
            let _ = jobs::fail(&connection, &job_id, &error_value);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    app: &tauri::AppHandle,
    project_path: &PathBuf,
    project_id: &str,
    job_id: &str,
    workflow_id: &str,
    idea: &str,
    creation_spec: &Value,
    target_duration: f64,
    chunk_duration: f64,
    snapshot: &mut Value,
) -> Result<Value, String> {
    let story = if let Some(story) = snapshot.get("story").cloned() {
        story
    } else {
        update_state(
            project_path,
            project_id,
            job_id,
            workflow_id,
            "story_bible",
            0.04,
            "正在生成剧情圣经",
            snapshot,
        )?;
        let story = crate::ai::generate_idea_story(app, idea, creation_spec).await?;
        snapshot["story"] = story.clone();
        update_state(
            project_path,
            project_id,
            job_id,
            workflow_id,
            "outline",
            0.12,
            "剧情圣经已完成，正在生成全片章节和分段大纲",
            snapshot,
        )?;
        story
    };

    let plan = if let Some(plan) = snapshot.get("plan").cloned() {
        plan
    } else {
        let foundation = if let Some(foundation) = snapshot.get("foundation").cloned() {
            foundation
        } else {
            let foundation =
                crate::ai::generate_long_idea_foundation(app, &story, creation_spec).await?;
            snapshot["foundation"] = foundation.clone();
            update_state(
                project_path,
                project_id,
                job_id,
                workflow_id,
                "outline",
                0.16,
                "角色、场景和章节基础设定已完成，正在生成分段大纲",
                snapshot,
            )?;
            foundation
        };
        let outline =
            crate::ai::generate_long_idea_outline(app, &foundation, creation_spec).await?;
        let mut raw_plan = foundation;
        raw_plan["segments"] = outline
            .get("segments")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let plan = normalize_plan(raw_plan, target_duration, chunk_duration, creation_spec)?;
        snapshot["plan"] = plan.clone();
        snapshot["completed_segments"] = json!([]);
        snapshot["continuity_state"] = plan
            .get("initial_continuity_state")
            .cloned()
            .unwrap_or_else(|| json!({}));
        snapshot["previous_summary"] = json!({});
        plan
    };

    if snapshot.get("outline_approved").and_then(Value::as_bool) != Some(true) {
        return pause_for_outline_review(project_path, project_id, job_id, workflow_id, snapshot);
    }
    update_state(
        project_path,
        project_id,
        job_id,
        workflow_id,
        "segments",
        0.20,
        "大纲已确认，正在顺序生成分镜",
        snapshot,
    )?;

    let segments = plan
        .get("segments")
        .and_then(Value::as_array)
        .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "全片大纲缺少分段任务"))?;
    let bible = json!({
        "story": plan.get("story").cloned().unwrap_or_else(|| story.clone()),
        "characters": plan.get("characters").cloned().unwrap_or_else(|| json!([])),
        "scenes": plan.get("scenes").cloned().unwrap_or_else(|| json!([])),
        "chapters": plan.get("chapters").cloned().unwrap_or_else(|| json!([])),
    });
    let mut completed = snapshot
        .get("completed_segments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut continuity = snapshot
        .get("continuity_state")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut previous_summary = snapshot
        .get("previous_summary")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut shot_start = completed
        .iter()
        .filter_map(|item| item.get("shots").and_then(Value::as_array))
        .map(Vec::len)
        .sum::<usize>()
        + 1;
    let mut global_cursor = completed
        .iter()
        .filter_map(|item| item.get("duration").and_then(Value::as_f64))
        .sum::<f64>();

    for index in completed.len()..segments.len() {
        let segment = &segments[index];
        let progress = 0.20 + 0.72 * (index as f64 / segments.len() as f64);
        update_state(
            project_path,
            project_id,
            job_id,
            workflow_id,
            "segments",
            progress,
            &format!("正在生成第{} / {}个分镜分段", index + 1, segments.len()),
            snapshot,
        )?;
        let mut revision_note = None;
        let normalized = loop {
            let raw = crate::ai::generate_long_idea_segment(
                app,
                &bible,
                segment,
                &previous_summary,
                &continuity,
                segments.get(index + 1),
                shot_start,
                revision_note.as_deref(),
                creation_spec,
            )
            .await?;
            match normalize_segment(
                raw,
                segment,
                index,
                shot_start,
                global_cursor,
                &bible,
                creation_spec,
            ) {
                Ok(value) => break value,
                Err(issue) if revision_note.is_none() => revision_note = Some(issue),
                Err(issue) => return Err(workflow_error("LONG_IDEA_SEGMENT_INVALID", issue)),
            }
        };
        let shot_count = normalized
            .get("shots")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let duration = segment
            .get("duration")
            .and_then(Value::as_f64)
            .unwrap_or(chunk_duration);
        shot_start += shot_count;
        global_cursor += duration;
        continuity = normalized
            .get("continuity_state")
            .cloned()
            .unwrap_or(continuity);
        previous_summary = normalized
            .get("segment_summary")
            .cloned()
            .unwrap_or_else(|| segment.get("summary").cloned().unwrap_or(Value::Null));
        completed.push(normalized);
        snapshot["completed_segments"] = Value::Array(completed.clone());
        snapshot["continuity_state"] = continuity.clone();
        snapshot["previous_summary"] = previous_summary.clone();
        let completed_progress = 0.20 + 0.72 * (completed.len() as f64 / segments.len() as f64);
        update_state(
            project_path,
            project_id,
            job_id,
            workflow_id,
            "segments",
            completed_progress,
            &format!("已完成第{} / {}个分镜分段", completed.len(), segments.len()),
            snapshot,
        )?;
    }

    update_state(
        project_path,
        project_id,
        job_id,
        workflow_id,
        "assembly",
        0.94,
        "所有分段已完成，正在合并并校验项目",
        snapshot,
    )?;
    let canonical = assemble_canonical(&story, &plan, &completed, target_duration)?;
    let mut connection = database::open(project_path)?;
    database::repository::save_canonical(&mut connection, project_id, &canonical)?;
    jobs::update(
        &connection,
        job_id,
        "COMPLETED",
        1.0,
        Some("completed"),
        Some("长篇创作工作流已完成"),
    )?;
    snapshot["canonical_summary"] = json!({
        "characters": canonical["characters"].as_array().map(Vec::len).unwrap_or(0),
        "scenes": canonical["scenes"].as_array().map(Vec::len).unwrap_or(0),
        "shots": canonical["shots"].as_array().map(Vec::len).unwrap_or(0),
        "duration": target_duration,
    });
    database::idea_workflows::update(
        &connection,
        workflow_id,
        "COMPLETED",
        "completed",
        1.0,
        "长篇剧情和分镜已全部生成",
        snapshot,
        None,
    )?;
    database::repository::load_bundle(&connection)
}

fn update_state(
    project_path: &PathBuf,
    _project_id: &str,
    job_id: &str,
    workflow_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
    snapshot: &Value,
) -> Result<(), String> {
    let connection = database::open(project_path)?;
    database::idea_workflows::update(
        &connection,
        workflow_id,
        "RUNNING",
        stage,
        progress,
        message,
        snapshot,
        None,
    )?;
    jobs::update(
        &connection,
        job_id,
        "RUNNING",
        progress,
        Some(stage),
        Some(message),
    )
}

fn pause_for_outline_review(
    project_path: &PathBuf,
    _project_id: &str,
    job_id: &str,
    workflow_id: &str,
    snapshot: &Value,
) -> Result<Value, String> {
    let connection = database::open(project_path)?;
    database::idea_workflows::update(
        &connection,
        workflow_id,
        "WAITING_INPUT",
        "outline",
        0.20,
        "剧情圣经和全片大纲已完成，等待用户确认",
        snapshot,
        None,
    )?;
    jobs::update(
        &connection,
        job_id,
        "PAUSED",
        0.20,
        Some("outline_review"),
        Some("等待用户查看并确认长篇大纲"),
    )?;
    database::repository::load_bundle(&connection)
}

fn normalize_plan(
    mut plan: Value,
    target_duration: f64,
    chunk_duration: f64,
    creation_spec: &Value,
) -> Result<Value, String> {
    for key in ["characters", "scenes", "chapters", "segments"] {
        if plan
            .get(key)
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            return Err(workflow_error(
                "LONG_IDEA_PLAN_INVALID",
                format!("全片大纲缺少{key}数据"),
            ));
        }
    }
    normalize_story_and_assets(&mut plan, creation_spec)?;
    let expected = (target_duration / chunk_duration).ceil() as usize;
    let segments = plan["segments"]
        .as_array_mut()
        .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "segments不是数组"))?;
    if segments.len() != expected {
        return Err(workflow_error(
            "LONG_IDEA_PLAN_INVALID",
            format!(
                "全片应拆分为{expected}段，但大模型返回了{}段",
                segments.len()
            ),
        ));
    }
    let mut remaining = target_duration;
    for (index, segment) in segments.iter_mut().enumerate() {
        let duration = remaining.min(chunk_duration);
        remaining -= duration;
        let object = segment
            .as_object_mut()
            .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "分段任务不是对象"))?;
        object.insert("id".into(), json!(format!("SEG_{:03}", index + 1)));
        object.insert("order".into(), json!(index + 1));
        object.insert("duration".into(), json!(duration));
    }
    Ok(plan)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn normalize_segment(
    mut result: Value,
    segment: &Value,
    segment_index: usize,
    shot_start: usize,
    global_cursor: f64,
    bible: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    if result
        .pointer("/continuity_check/valid")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Err(format!(
            "连续性自检未通过：{}",
            result
                .pointer("/continuity_check/issues")
                .cloned()
                .unwrap_or(Value::Null)
        ));
    }
    let segment_duration = segment
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_CHUNK_SECONDS);
    let scene_ids = bible["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let character_ids = bible["characters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let fallback_scene = scene_ids.iter().next().copied().unwrap_or("SCENE_001");
    let shots = result
        .get_mut("shots")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "当前分段没有返回shots数组".to_owned())?;
    if shots.is_empty() {
        return Err("当前分段没有生成任何分镜".to_owned());
    }
    compact_excess_shots(shots, segment_duration);
    let proposed_durations = shots
        .iter()
        .map(|shot| shot.get("duration").and_then(Value::as_f64).unwrap_or(0.0))
        .collect::<Vec<_>>();
    let durations = normalize_shot_durations(segment_duration, &proposed_durations)?;
    let story_beats = segment_shot_beats(segment, shots.len());
    let sequence_id = format!("SEQ_{:03}", segment_index + 1);
    let aspect_ratio = creation_spec
        .get("aspect_ratio")
        .and_then(Value::as_str)
        .unwrap_or("9:16");
    let visual_style = creation_spec
        .get("visual_style")
        .and_then(Value::as_str)
        .unwrap_or("电影级统一视觉风格");
    let mut cursor = global_cursor;
    let mut shot_ids = Vec::with_capacity(shots.len());
    let mut normalized_fingerprints = HashSet::new();
    for (offset, shot) in shots.iter_mut().enumerate() {
        let object = shot
            .as_object_mut()
            .ok_or_else(|| "分镜不是对象".to_owned())?;
        let id = format!("A-{:03}", shot_start + offset);
        let duration = durations[offset];
        let scene_id = object
            .get("scene_id")
            .and_then(Value::as_str)
            .filter(|id| scene_ids.contains(id))
            .unwrap_or(fallback_scene)
            .to_owned();
        let valid_characters = object
            .get("character_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| character_ids.contains(id))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let beat = story_beats
            .get(offset)
            .map(String::as_str)
            .unwrap_or("人物完成当前事件并产生明确结果");
        let (character_state_ids, character_state_lock) =
            resolve_shot_character_states(object, bible, &valid_characters, beat);
        object.insert("id".into(), json!(id));
        object.insert("sequence_id".into(), json!(sequence_id));
        object.insert("scene_id".into(), json!(scene_id));
        object.insert("character_ids".into(), json!(valid_characters));
        object.insert(
            "character_state_ids".into(),
            Value::Object(character_state_ids),
        );
        object.insert("duration".into(), json!(duration));
        object.insert(
            "source_time_range".into(),
            json!({"start":cursor,"end":cursor+duration}),
        );
        object.insert("aspect_ratio".into(), json!(aspect_ratio));
        object.insert("visual_style".into(), json!(visual_style));
        let prompt = object
            .get("video_prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model_visual = object
            .get("visual")
            .and_then(Value::as_str)
            .filter(|value| is_concrete_shot_text(value, 20))
            .or_else(|| prompt_field(prompt, "画面"))
            .filter(|value| is_concrete_shot_text(value, 20));
        let model_action = object
            .get("action")
            .and_then(Value::as_str)
            .filter(|value| is_concrete_shot_text(value, 6))
            .or_else(|| prompt_field(prompt, "动作"))
            .filter(|value| is_concrete_shot_text(value, 6));
        let model_camera = object
            .get("camera_movement")
            .and_then(Value::as_str)
            .filter(|value| !is_template_shot_text(value))
            .or_else(|| prompt_field(prompt, "运镜"))
            .filter(|value| !is_template_shot_text(value));
        let (scene_name, scene_description) = scene_context(bible, &scene_id);
        let mut visual = model_visual.map(str::to_owned).unwrap_or_else(|| {
            concrete_visual_fallback(beat, &scene_name, &scene_description, duration)
        });
        let mut action = model_action
            .map(str::to_owned)
            .unwrap_or_else(|| concrete_action_fallback(beat));
        let fingerprint = format!("{visual}\n{action}");
        if !normalized_fingerprints.insert(fingerprint) {
            visual = concrete_visual_fallback(beat, &scene_name, &scene_description, duration);
            action = concrete_action_fallback(beat);
            normalized_fingerprints.insert(format!("{visual}\n{action}"));
        }
        let camera_movement = model_camera
            .map(str::to_owned)
            .unwrap_or_else(|| concrete_camera_fallback(offset).to_owned());
        let dialogue = object
            .get("dialogue")
            .and_then(Value::as_str)
            .unwrap_or("无")
            .to_owned();
        let sound = object
            .get("sound")
            .and_then(Value::as_str)
            .unwrap_or("符合场景的环境声与配乐")
            .to_owned();
        let constraints = object
            .get("constraints")
            .or_else(|| object.get("negative_prompt"))
            .and_then(Value::as_str)
            .unwrap_or("角色、服装、场景和关键道具保持一致；动作自然；无畸形、无文字水印、无字幕")
            .to_owned();
        for (key, fallback) in [
            ("shot_size", "根据剧情选择景别"),
            ("camera_angle", "根据剧情选择机位"),
            ("camera_movement", camera_movement.as_str()),
            ("visual", visual.as_str()),
            ("action", action.as_str()),
            ("emotion", "符合当前剧情情绪"),
            ("dialogue", dialogue.as_str()),
            ("sound", sound.as_str()),
            ("scene_lock", "场景空间、光线、陈设和方位关系保持一致"),
            ("character_lock", character_state_lock.as_str()),
        ] {
            ensure_text(object, key, fallback);
        }
        object.insert("camera_movement".into(), json!(camera_movement));
        object.insert("visual".into(), json!(visual));
        object.insert("action".into(), json!(action));
        object.insert("character_lock".into(), json!(character_state_lock));
        ensure_text(object, "constraints", &constraints);
        ensure_text(object, "negative_prompt", &constraints);
        object
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        object.entry("video_assets").or_insert_with(|| json!([]));
        object.insert(
            "image_prompt".into(),
            json!(format!("画面：{visual}\n项目画风：{visual_style}")),
        );
        object.insert(
            "video_prompt".into(),
            json!(format!(
                "时长：{duration}秒\n运镜：{camera_movement}\n画面：{visual}\n动作：{action}\n台词：{dialogue}\n声音：{sound}\n约束：{constraints}\n项目画风：{visual_style}"
            )),
        );
        object.entry("status").or_insert(json!("DRAFT"));
        object.entry("locked").or_insert(json!(false));
        shot_ids.push(Value::String(id));
        cursor += duration;
    }
    let sequence_scene = shots
        .first()
        .and_then(|shot| shot.get("scene_id"))
        .cloned()
        .unwrap_or_else(|| json!(fallback_scene));
    result["sequence"] = json!({
        "id": sequence_id,
        "scene_id": sequence_scene,
        "order": segment_index + 1,
        "summary": result.get("segment_summary").cloned().or_else(|| segment.get("summary").cloned()).unwrap_or(Value::Null),
        "character_ids": segment.get("character_ids").cloned().unwrap_or_else(|| json!([])),
        "shot_ids": shot_ids,
    });
    result["duration"] = json!(segment_duration);
    result["segment_id"] = segment.get("id").cloned().unwrap_or(Value::Null);
    Ok(result)
}

fn compact_excess_shots(shots: &mut Vec<Value>, target_duration: f64) {
    let maximum_shots = (target_duration / 10.0).ceil().max(1.0) as usize;
    while shots.len() > maximum_shots {
        let merge_index = (0..shots.len() - 1)
            .rev()
            .find(|index| {
                shots[*index].get("scene_id").and_then(Value::as_str)
                    == shots[*index + 1].get("scene_id").and_then(Value::as_str)
            })
            .unwrap_or(shots.len() - 2);
        let following = shots.remove(merge_index + 1);
        merge_shot_content(&mut shots[merge_index], &following);
    }
}

fn merge_shot_content(target: &mut Value, following: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(following_object) = following.as_object() else {
        return;
    };
    for key in [
        "camera_movement",
        "visual",
        "action",
        "emotion",
        "dialogue",
        "sound",
    ] {
        let first = target_object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let second = following_object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let merged = merge_shot_text(first, second);
        if !merged.is_empty() {
            target_object.insert(key.to_owned(), json!(merged));
        }
    }
    let mut character_ids = target_object
        .get("character_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for id in following_object
        .get("character_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !character_ids.iter().any(|existing| existing == id) {
            character_ids.push(id.to_owned());
        }
    }
    target_object.insert("character_ids".into(), json!(character_ids));
    target_object.remove("image_prompt");
    target_object.remove("video_prompt");
}

fn merge_shot_text(first: &str, second: &str) -> String {
    let first = first.trim();
    let second = second.trim();
    if second.is_empty() || second == "无" || first.contains(second) {
        return first.to_owned();
    }
    if first.is_empty() || first == "无" {
        return second.to_owned();
    }
    format!("{first}；随后，{second}")
}

fn is_template_shot_text(value: &str) -> bool {
    value.trim().is_empty()
        || [
            "按当前剧情",
            "按剧情",
            "根据剧情",
            "符合当前剧情",
            "待补充",
            "人物自然行动",
            "呈现画面",
        ]
        .iter()
        .any(|needle| value.contains(needle))
}

fn is_concrete_shot_text(value: &str, minimum_characters: usize) -> bool {
    value.trim().chars().count() >= minimum_characters && !is_template_shot_text(value)
}

fn prompt_field<'a>(prompt: &'a str, label: &str) -> Option<&'a str> {
    prompt.lines().find_map(|line| {
        let line = line.trim();
        let (key, value) = line.split_once('：').or_else(|| line.split_once(':'))?;
        let value = value.trim();
        (key.trim() == label && !value.is_empty()).then_some(value)
    })
}

fn segment_shot_beats(segment: &Value, shot_count: usize) -> Vec<String> {
    if shot_count == 0 {
        return Vec::new();
    }
    let source = segment
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| segment.get("summary").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("人物完成本集核心事件，局面发生清晰变化");
    let mut sentences = Vec::new();
    let mut current = String::new();
    for character in source.chars() {
        current.push(character);
        if matches!(
            character,
            '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n'
        ) {
            let sentence = current.trim().to_owned();
            if !sentence.is_empty() {
                sentences.push(sentence);
            }
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current.trim().to_owned());
    }
    if sentences.is_empty() {
        sentences.push(source.to_owned());
    }

    let phases = [
        "建立人物、环境与目标的可见关系",
        "矛盾出现并引发人物的明确反应",
        "人物采取行动推动事件向前发展",
        "阻碍升级并改变人物或道具的状态",
        "关键行动产生可见且不可逆的结果",
        "人物回应结果并形成下一镜的衔接点",
    ];
    if sentences.len() >= shot_count {
        return (0..shot_count)
            .map(|index| {
                let start = index * sentences.len() / shot_count;
                let end = ((index + 1) * sentences.len() / shot_count).max(start + 1);
                let phase = phases[index % phases.len()];
                truncate_text(
                    &format!(
                        "事件节点{}：{} 本镜重点：{phase}",
                        index + 1,
                        sentences[start..end].join("")
                    ),
                    180,
                )
            })
            .collect();
    }

    (0..shot_count)
        .map(|index| {
            let sentence = &sentences[index % sentences.len()];
            let phase = phases[index % phases.len()];
            truncate_text(
                &format!("事件节点{}：{sentence} 本镜重点：{phase}", index + 1),
                180,
            )
        })
        .collect()
}

fn truncate_text(value: &str, maximum_characters: usize) -> String {
    value.chars().take(maximum_characters).collect()
}

fn scene_context(bible: &Value, scene_id: &str) -> (String, String) {
    let scene = bible
        .get("scenes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|scene| scene.get("id").and_then(Value::as_str) == Some(scene_id));
    let name = scene
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("当前场景")
        .to_owned();
    let description = scene
        .and_then(|value| {
            value
                .get("description")
                .or_else(|| value.get("visual_description"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("空间层次、人物位置、光线方向和关键道具均清晰可见");
    (name, truncate_text(description, 120))
}

fn concrete_visual_fallback(
    beat: &str,
    scene_name: &str,
    scene_description: &str,
    duration: f64,
) -> String {
    let midpoint = ((duration / 2.0) * 100.0).round() / 100.0;
    format!(
        "0-{midpoint}秒：{scene_name}中，{beat}；{midpoint}-{duration}秒：镜头落在事件造成的人物位置、表情和关键道具状态变化，背景呈现{scene_description}"
    )
}

fn concrete_action_fallback(beat: &str) -> String {
    format!("{beat}；人物完成动作后留下可见结果，并以视线、姿态或移动方向衔接下一镜")
}

fn concrete_camera_fallback(index: usize) -> &'static str {
    const CAMERA_MOVEMENTS: [&str; 6] = [
        "从场景全貌缓慢推进至关键人物的动作与表情",
        "跟随人物移动保持中景，动作发生时轻微前推",
        "先侧向移动交代人物关系，再停在关键动作的结果上",
        "从关键道具特写拉开，呈现人物与环境的空间关系",
        "保持稳定近景并随人物转身平移，落在事件造成的变化上",
        "从人物反应切入并缓慢后拉，交代动作结束后的现场状态",
    ];
    CAMERA_MOVEMENTS[index % CAMERA_MOVEMENTS.len()]
}

fn resolve_shot_character_states(
    shot: &serde_json::Map<String, Value>,
    bible: &Value,
    character_ids: &[String],
    beat: &str,
) -> (serde_json::Map<String, Value>, String) {
    let proposed = shot.get("character_state_ids").and_then(Value::as_object);
    let context = format!(
        "{beat} {} {}",
        shot.get("visual")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        shot.get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );
    let mut mappings = serde_json::Map::new();
    let mut locks = Vec::new();
    for character_id in character_ids {
        let Some(character) = bible
            .get("characters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|character| character.get("id").and_then(Value::as_str) == Some(character_id))
        else {
            continue;
        };
        let states = character
            .get("states")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|state| state.get("id").and_then(Value::as_str).is_some())
            .collect::<Vec<_>>();
        if states.is_empty() {
            continue;
        }
        let proposed_id = proposed
            .and_then(|mapping| mapping.get(character_id))
            .and_then(Value::as_str);
        let selected = proposed_id
            .and_then(|state_id| {
                states
                    .iter()
                    .copied()
                    .find(|state| state.get("id").and_then(Value::as_str) == Some(state_id))
            })
            .or_else(|| {
                states.iter().copied().rev().find(|state| {
                    let name = state
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let keyword = name.trim_end_matches("状态");
                    let trigger = state
                        .get("trigger")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    (!name.is_empty() && context.contains(name))
                        || (keyword.chars().count() >= 2 && context.contains(keyword))
                        || (!trigger.is_empty() && context.contains(trigger))
                })
            })
            .unwrap_or(states[0]);
        let state_id = selected
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        mappings.insert(character_id.clone(), json!(state_id));
        let character_name = character
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(character_id);
        let state_name = selected
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("默认状态");
        let appearance = selected
            .get("appearance_lock")
            .and_then(Value::as_str)
            .or_else(|| character.get("appearance_lock").and_then(Value::as_str))
            .unwrap_or("五官、发型和体态保持一致");
        let clothing = selected
            .get("clothing_lock")
            .and_then(Value::as_str)
            .or_else(|| character.get("clothing_lock").and_then(Value::as_str))
            .unwrap_or("服装与配饰保持一致");
        locks.push(format!(
            "{character_name}使用“{state_name}”（{state_id}）：{appearance}；{clothing}"
        ));
    }
    let lock = if locks.is_empty() {
        "人物名称、五官、发型、服装和声音保持一致".to_owned()
    } else {
        locks.join("\n")
    };
    (mappings, lock)
}

fn normalize_shot_durations(target_duration: f64, proposed: &[f64]) -> Result<Vec<f64>, String> {
    if proposed.is_empty() || !target_duration.is_finite() || target_duration <= 0.0 {
        return Err("分镜数量或目标时长无效".to_owned());
    }
    let proposed_total = proposed.iter().sum::<f64>();
    let proposed_is_valid = (proposed_total - target_duration).abs() <= 0.01
        && proposed.iter().enumerate().all(|(index, duration)| {
            duration.is_finite()
                && *duration > 0.0
                && *duration <= 15.01
                && (*duration >= 9.99 || index + 1 == proposed.len())
        });
    if proposed_is_valid {
        return Ok(proposed.to_vec());
    }

    let target_centiseconds = (target_duration * 100.0).round() as i64;
    let shot_count = proposed.len() as i64;
    let minimum_centiseconds = if shot_count == 1 {
        1
    } else {
        1_000 * (shot_count - 1) + 1
    };
    let maximum_centiseconds = 1_500 * shot_count;
    if target_centiseconds < minimum_centiseconds || target_centiseconds > maximum_centiseconds {
        let minimum_shots = (target_duration / 15.0).ceil().max(1.0) as usize;
        let maximum_shots = (target_duration / 10.0).ceil().max(1.0) as usize;
        return Err(format!(
            "分镜数量不适合当前时长：当前分段要求{target_duration}秒，模型返回{}个分镜、总时长{proposed_total}秒；应生成{minimum_shots}～{maximum_shots}个分镜",
            proposed.len()
        ));
    }

    let mut centiseconds = if target_centiseconds >= 1_000 * shot_count {
        let base = target_centiseconds / shot_count;
        let remainder = target_centiseconds % shot_count;
        (0..shot_count)
            .map(|index| base + i64::from(index < remainder))
            .collect::<Vec<_>>()
    } else {
        let mut values = vec![1_000; proposed.len()];
        if let Some(last) = values.last_mut() {
            *last = target_centiseconds - 1_000 * (shot_count - 1);
        }
        values
    };
    let assigned = centiseconds.iter().sum::<i64>();
    if let Some(last) = centiseconds.last_mut() {
        *last += target_centiseconds - assigned;
    }
    Ok(centiseconds
        .into_iter()
        .map(|value| value as f64 / 100.0)
        .collect())
}

fn normalize_story_and_assets(plan: &mut Value, creation_spec: &Value) -> Result<(), String> {
    let aspect_ratio = creation_spec
        .get("aspect_ratio")
        .and_then(Value::as_str)
        .unwrap_or("9:16");
    let visual_style = creation_spec
        .get("visual_style")
        .and_then(Value::as_str)
        .unwrap_or("电影级统一视觉风格");
    let story = plan
        .get_mut("story")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "全片大纲缺少story对象"))?;
    for (key, fallback) in [
        ("title", "未命名长篇项目"),
        ("logline", "围绕核心人物展开的完整故事"),
        ("theme", "成长与选择"),
        ("synopsis", "按全片章节大纲展开"),
        ("tone", "电影化叙事"),
    ] {
        ensure_text(story, key, fallback);
    }
    story.entry("genre").or_insert_with(|| json!([]));
    story.insert("aspect_ratio".into(), json!(aspect_ratio));
    story.insert("visual_style".into(), json!(visual_style));

    for (index, character) in plan["characters"]
        .as_array_mut()
        .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "characters不是数组"))?
        .iter_mut()
        .enumerate()
    {
        let character = character
            .as_object_mut()
            .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "角色数据不是对象"))?;
        ensure_text(character, "id", &format!("CHAR_{:03}", index + 1));
        ensure_text(character, "name", &format!("角色{}", index + 1));
        ensure_text(character, "role", "剧情角色");
        ensure_text(character, "gender", "未指定");
        ensure_text(character, "age_range", "未指定");
        ensure_text(character, "voice", "符合人物设定的声音");
        ensure_text(character, "story_function", "推动剧情发展");
        let appearance_lock = character
            .get("appearance_lock")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("五官清晰且跨镜头保持一致")
            .to_owned();
        let clothing_lock = character
            .get("clothing_lock")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("服装跨镜头保持一致")
            .to_owned();
        let mut appearance = normalize_appearance(character.remove("appearance"));
        for (key, fallback) in [
            ("face", appearance_lock.as_str()),
            ("hair", "发型跨镜头保持一致"),
            ("body", "自然人体比例"),
            ("clothes", clothing_lock.as_str()),
            ("accessories", "无"),
        ] {
            ensure_text(&mut appearance, key, fallback);
        }
        character.insert("appearance".into(), Value::Object(appearance));
        character
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        character.entry("locked").or_insert(json!(false));
    }

    for (index, scene) in plan["scenes"]
        .as_array_mut()
        .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "scenes不是数组"))?
        .iter_mut()
        .enumerate()
    {
        let scene = scene
            .as_object_mut()
            .ok_or_else(|| workflow_error("LONG_IDEA_PLAN_INVALID", "场景数据不是对象"))?;
        ensure_text(scene, "id", &format!("SCENE_{:03}", index + 1));
        ensure_text(scene, "name", &format!("场景{}", index + 1));
        for (key, fallback) in [
            ("location_type", "按剧情设定"),
            ("time_of_day", "按剧情设定"),
            ("description", "完整描述场景空间与环境"),
            ("lighting", "符合剧情氛围的光线"),
            ("layout", "空间关系清晰且保持一致"),
            ("mood", "符合当前剧情情绪"),
        ] {
            ensure_text(scene, key, fallback);
        }
        scene.entry("props").or_insert_with(|| json!([]));
        scene.entry("reference_assets").or_insert_with(|| json!([]));
        scene.entry("locked").or_insert(json!(false));
    }
    crate::character_state_policy::normalize(plan);
    Ok(())
}

fn normalize_appearance(value: Option<Value>) -> serde_json::Map<String, Value> {
    match value {
        Some(Value::Object(appearance)) => appearance,
        Some(Value::String(description)) if !description.trim().is_empty() => {
            serde_json::Map::from_iter([("face".into(), Value::String(description))])
        }
        Some(Value::Array(parts)) => {
            let description = parts
                .into_iter()
                .filter_map(|part| {
                    part.as_str()
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>()
                .join("；");
            if description.is_empty() {
                serde_json::Map::new()
            } else {
                serde_json::Map::from_iter([("face".into(), Value::String(description))])
            }
        }
        _ => serde_json::Map::new(),
    }
}

fn ensure_text(object: &mut serde_json::Map<String, Value>, key: &str, fallback: &str) {
    if object
        .get(key)
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        object.insert(key.to_owned(), json!(fallback));
    }
}

pub(crate) fn assemble_canonical(
    story: &Value,
    plan: &Value,
    completed: &[Value],
    target_duration: f64,
) -> Result<Value, String> {
    let sequences = completed
        .iter()
        .filter_map(|item| item.get("sequence").cloned())
        .collect::<Vec<_>>();
    let shots = completed
        .iter()
        .filter_map(|item| item.get("shots").and_then(Value::as_array))
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    let total = shots
        .iter()
        .filter_map(|shot| shot.get("duration").and_then(Value::as_f64))
        .sum::<f64>();
    if (total - target_duration).abs() > 1.0 {
        return Err(workflow_error(
            "LONG_IDEA_DURATION_MISMATCH",
            format!("最终分镜总时长{total}秒，与目标{target_duration}秒不一致"),
        ));
    }
    Ok(json!({
        "story": plan.get("story").cloned().unwrap_or_else(|| story.clone()),
        "characters": plan.get("characters").cloned().unwrap_or_else(|| json!([])),
        "scenes": plan.get("scenes").cloned().unwrap_or_else(|| json!([])),
        "sequences": sequences,
        "shots": shots,
    }))
}

fn workflow_progress(snapshot: &Value) -> f64 {
    let total = snapshot
        .pointer("/plan/segments")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let completed = snapshot
        .get("completed_segments")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if total == 0 {
        if snapshot.get("foundation").is_some() {
            0.16
        } else if snapshot.get("story").is_some() {
            0.12
        } else {
            0.02
        }
    } else {
        0.20 + 0.72 * completed as f64 / total as f64
    }
}

fn workflow_error(code: &str, message: impl Into<String>) -> String {
    json!({"code":code,"message":message.into(),"retryable":true}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_long_plan_to_exact_segment_budget() {
        let plan = json!({
            "story":{"title":"测试长篇","logline":"测试","genre":[],"theme":"测试","synopsis":"测试","tone":"测试"},
            "characters":[{"id":"CHAR_001"}], "scenes":[{"id":"SCENE_001"}],
            "chapters":[{"id":"CH_001"}],
            "segments": (0..4).map(|index| json!({"summary":format!("第{index}段")})).collect::<Vec<_>>()
        });
        let normalized = normalize_plan(
            plan,
            330.0,
            90.0,
            &json!({"aspect_ratio":"16:9","visual_style":"电影感"}),
        )
        .unwrap();
        let durations = normalized["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["duration"].as_f64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(durations, vec![90.0, 90.0, 90.0, 60.0]);
    }

    #[test]
    fn normalizes_text_character_appearance_without_losing_description() {
        let plan = json!({
            "story":{"title":"测试长篇"},
            "characters":[{
                "id":"CHAR_001",
                "appearance":"棱角分明的脸，短发，高大身形，身穿黑色风衣",
                "clothing_lock":"黑色风衣"
            }],
            "scenes":[{"id":"SCENE_001"}],
            "chapters":[{"id":"CH_001"}],
            "segments":[{"summary":"测试分段"}]
        });
        let normalized = normalize_plan(
            plan,
            90.0,
            90.0,
            &json!({"aspect_ratio":"16:9","visual_style":"电影感"}),
        )
        .unwrap();
        let appearance = &normalized["characters"][0]["appearance"];
        assert!(appearance.is_object());
        assert_eq!(
            appearance["face"],
            "棱角分明的脸，短发，高大身形，身穿黑色风衣"
        );
        assert_eq!(appearance["clothes"], "黑色风衣");
        assert_eq!(appearance["accessories"], "无");
    }

    #[test]
    fn recalibrates_model_shot_durations_to_exact_segment_budget() {
        let from_eighty =
            normalize_shot_durations(60.0, &[15.0, 15.0, 15.0, 15.0, 10.0, 10.0]).unwrap();
        let from_seventy_two =
            normalize_shot_durations(60.0, &[12.0, 12.0, 12.0, 12.0, 12.0, 12.0]).unwrap();
        assert_eq!(from_eighty, vec![10.0; 6]);
        assert_eq!(from_seventy_two, vec![10.0; 6]);
        assert!((from_eighty.iter().sum::<f64>() - 60.0).abs() < f64::EPSILON);
    }

    #[test]
    fn rejects_a_shot_count_that_cannot_fit_the_segment() {
        let error = normalize_shot_durations(60.0, &[10.0; 7]).unwrap_err();
        assert!(error.contains("应生成4～6个分镜"));
    }

    #[test]
    fn compacts_excess_shots_before_duration_recalibration() {
        let mut shots = (1..=8)
            .map(|index| {
                json!({
                    "scene_id":"SCENE_001",
                    "character_ids":["CHAR_001"],
                    "duration":10,
                    "visual":format!("镜头{index}的具体画面内容"),
                    "action":format!("镜头{index}的具体动作")
                })
            })
            .collect::<Vec<_>>();
        compact_excess_shots(&mut shots, 60.0);
        assert_eq!(shots.len(), 6);
        assert!(shots.iter().any(|shot| shot["visual"]
            .as_str()
            .is_some_and(|visual| visual.contains("镜头8"))));
    }

    #[test]
    fn repairs_template_storyboard_fields_with_episode_events() {
        let segment = json!({
            "id":"EP_001",
            "duration":60,
            "content":"孙野推开餐馆大门，发现劫匪挟持店员。劫匪挥刀逼近柜台。孙野抓住托盘挡下攻击。金色力量沿手臂亮起并震开匪徒。店员脱险后，孙野收起力量离开现场。"
        });
        let result = json!({
            "shots":(0..5).map(|_| json!({
                "duration":12,
                "scene_id":"SCENE_001",
                "character_ids":["CHAR_001"],
                "visual":"按当前剧情大纲呈现画面",
                "action":"人物按剧情自然行动",
                "camera_movement":"根据剧情自然运镜",
                "video_prompt":"运镜：根据剧情自然运镜\n画面：按当前剧情大纲呈现画面\n动作：人物按剧情自然行动"
            })).collect::<Vec<_>>()
        });
        let bible = json!({
            "scenes":[{"id":"SCENE_001","name":"深夜餐馆","description":"冷白顶灯照亮狭长过道，玻璃门外雨水反光，柜台旁散落餐盘"}],
            "characters":[{"id":"CHAR_001","name":"孙野"}]
        });
        let normalized = normalize_segment(
            result,
            &segment,
            0,
            1,
            0.0,
            &bible,
            &json!({"aspect_ratio":"16:9","visual_style":"电影写实"}),
        )
        .unwrap();
        let shots = normalized["shots"].as_array().unwrap();
        assert_eq!(shots.len(), 5);
        let fingerprints = shots
            .iter()
            .map(|shot| {
                let visual = shot["visual"].as_str().unwrap();
                let action = shot["action"].as_str().unwrap();
                let camera = shot["camera_movement"].as_str().unwrap();
                let video_prompt = shot["video_prompt"].as_str().unwrap();
                assert!(visual.chars().count() >= 20);
                assert!(!is_template_shot_text(visual));
                assert!(!is_template_shot_text(action));
                assert!(!is_template_shot_text(camera));
                assert!(!is_template_shot_text(video_prompt));
                format!("{visual}\n{action}")
            })
            .collect::<HashSet<_>>();
        assert_eq!(fingerprints.len(), shots.len());
    }

    #[test]
    fn selects_the_matching_visual_state_for_a_storyboard_shot() {
        let shot = json!({
            "visual":"孙小野完成神变，金色齐天战甲覆盖全身",
            "action":"他握紧金箍棒挡下攻击"
        });
        let bible = json!({
            "characters":[{
                "id":"CHAR_001",
                "name":"孙小野",
                "states":[
                    {"id":"CHAR_001_STATE_001","name":"凡人状态","appearance_lock":"黑色短发","clothing_lock":"深蓝外卖夹克"},
                    {"id":"CHAR_001_STATE_002","name":"神变状态","appearance_lock":"黑色短发","clothing_lock":"金色齐天战甲"}
                ]
            }]
        });
        let (mappings, lock) = resolve_shot_character_states(
            shot.as_object().unwrap(),
            &bible,
            &[String::from("CHAR_001")],
            "孙小野在危急时刻完成神变",
        );
        assert_eq!(
            mappings.get("CHAR_001").and_then(Value::as_str),
            Some("CHAR_001_STATE_002")
        );
        assert!(lock.contains("神变状态"));
        assert!(lock.contains("金色齐天战甲"));
    }
}
