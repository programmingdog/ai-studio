use std::{collections::HashSet, path::PathBuf};

use serde_json::{json, Map, Value};

use crate::database;

const DEFAULT_EPISODE_SECONDS: f64 = 90.0;
const MAX_STAGE_ATTEMPTS: usize = 4;

pub async fn start(
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
        .clamp(5.0, 3600.0);
    let connection = database::open(&project_path)?;
    if let Some(existing) = database::idea_workflows::latest(&connection, &project_id)? {
        if existing.status == "WAITING_INPUT" || existing.status == "COMPLETED" {
            return database::repository::load_bundle(&connection);
        }
    }
    let workflow = database::idea_workflows::create(
        &connection,
        &project_id,
        target_duration,
        DEFAULT_EPISODE_SECONDS,
    )?;
    drop(connection);

    let result = crate::ai::generate_guided_idea_outline(app, &idea, &creation_spec)
        .await
        .and_then(|raw| normalize_story(raw, &creation_spec));
    match result {
        Ok(story) => {
            let snapshot = json!({"story": story});
            let connection = database::open(&project_path)?;
            database::idea_workflows::update(
                &connection,
                &workflow.id,
                "WAITING_INPUT",
                "outline_review",
                0.20,
                "整体大纲已生成，请修改或确认",
                &snapshot,
                None,
            )?;
            database::repository::load_bundle(&connection)
        }
        Err(error) => {
            fail_workflow(
                &project_path,
                &workflow.id,
                "outline_review",
                &workflow.snapshot,
                &error,
            );
            Err(error)
        }
    }
}

pub async fn apply_action(
    app: &tauri::AppHandle,
    project_path: PathBuf,
    project_id: String,
    workflow_id: String,
    action: String,
    payload: Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    let connection = database::open(&project_path)?;
    let workflow = database::idea_workflows::get(&connection, &workflow_id)?
        .ok_or_else(|| workflow_error("GUIDED_IDEA_WORKFLOW_NOT_FOUND", "找不到创意分步工作流"))?;
    if workflow.project_id != project_id {
        return Err(workflow_error(
            "GUIDED_IDEA_PROJECT_MISMATCH",
            "工作流不属于当前项目",
        ));
    }
    let bundle = database::repository::load_bundle(&connection)?;
    drop(connection);
    let creation_spec = bundle
        .get("creation_spec")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let idea = bundle
        .get("source_text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut snapshot = workflow.snapshot.clone();

    if action == "cancel" {
        let connection = database::open(&project_path)?;
        return database::idea_workflows::update(
            &connection,
            &workflow_id,
            "CANCELLED",
            &workflow.stage,
            workflow.progress,
            "创意分步流程已取消，已生成草稿仍保存在项目数据库中",
            &snapshot,
            None,
        );
    }

    let result = apply_action_inner(
        app,
        &project_path,
        &project_id,
        &workflow_id,
        &action,
        &payload,
        &idea,
        &creation_spec,
        &mut snapshot,
    )
    .await;
    if let Err(error) = &result {
        fail_workflow(
            &project_path,
            &workflow_id,
            &workflow.stage,
            &snapshot,
            error,
        );
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn apply_action_inner(
    app: &tauri::AppHandle,
    project_path: &PathBuf,
    project_id: &str,
    workflow_id: &str,
    action: &str,
    payload: &Value,
    idea: &str,
    creation_spec: &Value,
    snapshot: &mut Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    match action {
        "save_outline" => {
            snapshot["story"] = normalize_story(payload_value(payload, "story"), creation_spec)?;
            update_waiting(
                project_path,
                workflow_id,
                "outline_review",
                0.20,
                "整体大纲修改已保存",
                snapshot,
            )
        }
        "regenerate_outline" | "retry_outline" => {
            update_running(
                project_path,
                workflow_id,
                "outline_review",
                0.08,
                "正在重新生成整体大纲",
                snapshot,
            )?;
            snapshot["story"] = normalize_story(
                crate::ai::generate_guided_idea_outline(app, idea, creation_spec).await?,
                creation_spec,
            )?;
            update_waiting(
                project_path,
                workflow_id,
                "outline_review",
                0.20,
                "整体大纲已重新生成，请修改或确认",
                snapshot,
            )
        }
        "confirm_outline" => {
            snapshot["story"] = normalize_story(payload_value(payload, "story"), creation_spec)?;
            update_running(
                project_path,
                workflow_id,
                "episodes_review",
                0.24,
                "大纲已确认，正在拆分分集",
                snapshot,
            )?;
            let target_duration = target_duration(creation_spec);
            let count = episode_count(target_duration);
            let episodes = generate_valid_episodes(
                app,
                &snapshot["story"],
                count,
                target_duration,
                creation_spec,
            )
            .await?;
            snapshot["episodes"] = Value::Array(episodes.clone());
            let mut connection = database::open(project_path)?;
            database::episodes::replace(&mut connection, project_id, &episodes)?;
            drop(connection);
            update_waiting(
                project_path,
                workflow_id,
                "episodes_review",
                0.40,
                "分集已生成并保存，请编辑或确认",
                snapshot,
            )
        }
        "save_episodes" => {
            let episodes = normalize_episodes(
                payload_array(payload, "episodes")?,
                target_duration(creation_spec),
            )?;
            snapshot["episodes"] = Value::Array(episodes.clone());
            let mut connection = database::open(project_path)?;
            database::episodes::replace(&mut connection, project_id, &episodes)?;
            drop(connection);
            update_waiting(
                project_path,
                workflow_id,
                "episodes_review",
                0.40,
                "分集修改已保存到数据库",
                snapshot,
            )
        }
        "regenerate_episodes" | "retry_episodes" => {
            let story = snapshot.get("story").cloned().ok_or_else(|| {
                workflow_error("GUIDED_IDEA_OUTLINE_REQUIRED", "请先完成整体大纲")
            })?;
            update_running(
                project_path,
                workflow_id,
                "episodes_review",
                0.28,
                "正在根据已确认大纲重新拆分分集",
                snapshot,
            )?;
            let target_duration = target_duration(creation_spec);
            let episodes = generate_valid_episodes(
                app,
                &story,
                episode_count(target_duration),
                target_duration,
                creation_spec,
            )
            .await?;
            snapshot["episodes"] = Value::Array(episodes.clone());
            let mut connection = database::open(project_path)?;
            database::episodes::replace(&mut connection, project_id, &episodes)?;
            drop(connection);
            update_waiting(
                project_path,
                workflow_id,
                "episodes_review",
                0.40,
                "分集已重新生成并保存",
                snapshot,
            )
        }
        "confirm_episodes" => {
            let episodes = normalize_episodes(
                payload_array(payload, "episodes")?,
                target_duration(creation_spec),
            )?;
            snapshot["episodes"] = Value::Array(episodes.clone());
            let mut connection = database::open(project_path)?;
            database::episodes::replace(&mut connection, project_id, &episodes)?;
            drop(connection);
            update_running(
                project_path,
                workflow_id,
                "assets_review",
                0.44,
                "分集已确认，正在提取角色和场景",
                snapshot,
            )?;
            let assets = generate_valid_assets(
                app,
                &snapshot["story"],
                &snapshot["episodes"],
                creation_spec,
            )
            .await?;
            snapshot["characters"] = assets["characters"].clone();
            snapshot["scenes"] = assets["scenes"].clone();
            update_waiting(
                project_path,
                workflow_id,
                "assets_review",
                0.58,
                "角色与场景已提取，请添加、修改、删除或确认",
                snapshot,
            )
        }
        "save_assets" => {
            let assets = normalize_assets(payload.clone())?;
            snapshot["characters"] = assets["characters"].clone();
            snapshot["scenes"] = assets["scenes"].clone();
            update_waiting(
                project_path,
                workflow_id,
                "assets_review",
                0.58,
                "角色与场景修改已保存",
                snapshot,
            )
        }
        "regenerate_assets" | "retry_assets" => {
            update_running(
                project_path,
                workflow_id,
                "assets_review",
                0.46,
                "正在从全部分集重新提取角色和场景",
                snapshot,
            )?;
            let assets = generate_valid_assets(
                app,
                &snapshot["story"],
                &snapshot["episodes"],
                creation_spec,
            )
            .await?;
            snapshot["characters"] = assets["characters"].clone();
            snapshot["scenes"] = assets["scenes"].clone();
            update_waiting(
                project_path,
                workflow_id,
                "assets_review",
                0.58,
                "角色与场景已重新提取",
                snapshot,
            )
        }
        "confirm_assets" | "retry_storyboards" | "regenerate_storyboards" => {
            if action == "confirm_assets" {
                let assets = normalize_assets(payload.clone())?;
                snapshot["characters"] = assets["characters"].clone();
                snapshot["scenes"] = assets["scenes"].clone();
            }
            if action == "regenerate_storyboards" {
                snapshot["completed_episode_storyboards"] = json!([]);
                snapshot["continuity_state"] = json!({});
                if let Some(object) = snapshot.as_object_mut() {
                    object.remove("canonical_summary");
                }
            }
            generate_storyboards(
                app,
                project_path,
                project_id,
                workflow_id,
                creation_spec,
                snapshot,
            )
            .await
        }
        "confirm_storyboards" => finalize_storyboards(
            project_path,
            project_id,
            workflow_id,
            creation_spec,
            snapshot,
        ),
        _ => Err(workflow_error(
            "GUIDED_IDEA_ACTION_INVALID",
            format!("不支持的工作流操作：{action}"),
        )),
    }
}

async fn generate_valid_episodes(
    app: &tauri::AppHandle,
    story: &Value,
    count: usize,
    duration: f64,
    creation_spec: &Value,
) -> Result<Vec<Value>, String> {
    let mut last_error = workflow_error("GUIDED_IDEA_EPISODES_INVALID", "分集生成失败");
    for _ in 0..MAX_STAGE_ATTEMPTS {
        let raw =
            crate::ai::generate_guided_idea_episodes(app, story, count, duration, creation_spec)
                .await?;
        match normalize_episodes(
            raw.get("episodes")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    workflow_error("GUIDED_IDEA_EPISODES_INVALID", "大模型未返回episodes数组")
                })?,
            duration,
        ) {
            Ok(episodes) if episodes.len() == count => return Ok(episodes),
            Ok(episodes) => {
                last_error = workflow_error(
                    "GUIDED_IDEA_EPISODES_INVALID",
                    format!("应生成{count}集，实际返回{}集", episodes.len()),
                )
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

async fn generate_valid_assets(
    app: &tauri::AppHandle,
    story: &Value,
    episodes: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    let mut last_error = workflow_error("GUIDED_IDEA_ASSETS_INVALID", "角色与场景提取失败");
    for _ in 0..MAX_STAGE_ATTEMPTS {
        let raw =
            crate::ai::generate_guided_idea_assets(app, story, episodes, creation_spec).await?;
        match normalize_assets(raw) {
            Ok(assets) => return Ok(assets),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

async fn generate_storyboards(
    app: &tauri::AppHandle,
    project_path: &PathBuf,
    _project_id: &str,
    workflow_id: &str,
    creation_spec: &Value,
    snapshot: &mut Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    let episodes = snapshot
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_EPISODES_REQUIRED", "请先确认分集"))?;
    let characters = snapshot
        .get("characters")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_REQUIRED", "请先确认角色"))?;
    let scenes = snapshot
        .get("scenes")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_REQUIRED", "请先确认场景"))?;
    let story = snapshot
        .get("story")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_OUTLINE_REQUIRED", "请先确认整体大纲"))?;
    let bible = json!({"story":story,"characters":characters,"scenes":scenes});
    let mut completed = snapshot
        .get("completed_episode_storyboards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut continuity = snapshot
        .get("continuity_state")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut previous_summary = completed
        .last()
        .and_then(|item| item.get("segment_summary"))
        .cloned()
        .unwrap_or(Value::Null);
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
    update_running(
        project_path,
        workflow_id,
        "storyboards",
        0.60,
        "角色与场景已确认，正在逐集生成分镜脚本",
        snapshot,
    )?;

    for index in completed.len()..episodes.len() {
        let episode = &episodes[index];
        let progress = 0.60 + 0.35 * index as f64 / episodes.len() as f64;
        update_running(
            project_path,
            workflow_id,
            "storyboards",
            progress,
            &format!("正在生成第{} / {}集分镜脚本", index + 1, episodes.len()),
            snapshot,
        )?;
        let mut revision_note: Option<String> = None;
        let mut normalized = None;
        for _ in 0..MAX_STAGE_ATTEMPTS {
            let raw = crate::ai::generate_guided_episode_storyboard(
                app,
                &story,
                episode,
                &characters,
                &scenes,
                &previous_summary,
                &continuity,
                shot_start,
                revision_note.as_deref(),
                creation_spec,
            )
            .await?;
            match crate::long_idea::normalize_segment(
                raw,
                episode,
                index,
                shot_start,
                global_cursor,
                &bible,
                creation_spec,
            )
            .map(|value| enrich_episode_segment(value, episode))
            .and_then(validate_meaningful_storyboard)
            {
                Ok(value) => {
                    normalized = Some(value);
                    break;
                }
                Err(issue) => revision_note = Some(issue),
            }
        }
        let normalized = normalized.ok_or_else(|| {
            workflow_error(
                "GUIDED_IDEA_STORYBOARD_INVALID",
                revision_note.unwrap_or_else(|| "分镜脚本缺少具体内容".to_owned()),
            )
        })?;
        let shot_count = normalized
            .get("shots")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        shot_start += shot_count;
        global_cursor += episode
            .get("duration")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_EPISODE_SECONDS);
        continuity = normalized
            .get("continuity_state")
            .cloned()
            .unwrap_or(continuity);
        previous_summary = normalized
            .get("segment_summary")
            .cloned()
            .unwrap_or_else(|| episode.get("content").cloned().unwrap_or(Value::Null));
        completed.push(normalized);
        snapshot["completed_episode_storyboards"] = Value::Array(completed.clone());
        snapshot["continuity_state"] = continuity.clone();
        update_running(
            project_path,
            workflow_id,
            "storyboards",
            0.60 + 0.35 * completed.len() as f64 / episodes.len() as f64,
            &format!("已完成第{} / {}集分镜脚本", completed.len(), episodes.len()),
            snapshot,
        )?;
    }

    let canonical = crate::long_idea::assemble_canonical(
        &story,
        &bible,
        &completed,
        target_duration(creation_spec),
    )?;
    snapshot["canonical_summary"] = json!({
        "characters": canonical["characters"].as_array().map(Vec::len).unwrap_or(0),
        "scenes": canonical["scenes"].as_array().map(Vec::len).unwrap_or(0),
        "shots": canonical["shots"].as_array().map(Vec::len).unwrap_or(0),
        "duration": target_duration(creation_spec),
    });
    update_waiting(
        project_path,
        workflow_id,
        "storyboards_review",
        0.96,
        "全部分集分镜脚本已生成，请查看并确认完成",
        snapshot,
    )
}

fn finalize_storyboards(
    project_path: &PathBuf,
    project_id: &str,
    workflow_id: &str,
    creation_spec: &Value,
    snapshot: &mut Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    let story = snapshot
        .get("story")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_OUTLINE_REQUIRED", "请先确认整体大纲"))?;
    let episodes = snapshot
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_EPISODES_REQUIRED", "请先确认分集"))?;
    let characters = snapshot
        .get("characters")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_REQUIRED", "请先确认角色"))?;
    let scenes = snapshot
        .get("scenes")
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_REQUIRED", "请先确认场景"))?;
    let completed = snapshot
        .get("completed_episode_storyboards")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_STORYBOARD_REQUIRED", "请先生成分镜脚本"))?;
    if completed.len() != episodes.len() {
        return Err(workflow_error(
            "GUIDED_IDEA_STORYBOARD_INCOMPLETE",
            format!(
                "分镜脚本尚未全部生成：已完成{} / {}集",
                completed.len(),
                episodes.len()
            ),
        ));
    }
    let bible = json!({"story":story,"characters":characters,"scenes":scenes});
    let mut canonical = crate::long_idea::assemble_canonical(
        &story,
        &bible,
        &completed,
        target_duration(creation_spec),
    )?;
    canonical["episodes"] = Value::Array(episodes);
    let mut connection = database::open(project_path)?;
    database::repository::save_canonical(&mut connection, project_id, &canonical)?;
    database::idea_workflows::update(
        &connection,
        workflow_id,
        "COMPLETED",
        "completed",
        1.0,
        "全部步骤已由用户确认，剧本与分镜已保存",
        snapshot,
        None,
    )
}

fn normalize_story(raw: Value, creation_spec: &Value) -> Result<Value, String> {
    let mut story = raw.get("story").cloned().unwrap_or(raw);
    let object = story
        .as_object_mut()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_OUTLINE_INVALID", "整体大纲不是对象"))?;
    for (key, fallback) in [
        ("title", "未命名项目"),
        ("logline", "围绕核心冲突展开的故事"),
        ("theme", "选择与成长"),
        ("tone", "电影化叙事"),
    ] {
        ensure_text(object, key, fallback);
    }
    let synopsis = object
        .get("synopsis")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if synopsis.chars().count() < 40 {
        return Err(workflow_error(
            "GUIDED_IDEA_OUTLINE_INVALID",
            "整体大纲过短或缺少具体剧情",
        ));
    }
    object.insert(
        "synopsis".into(),
        json!(synopsis.chars().take(3000).collect::<String>()),
    );
    object.entry("genre").or_insert_with(|| json!([]));
    object.insert(
        "aspect_ratio".into(),
        creation_spec
            .get("aspect_ratio")
            .cloned()
            .unwrap_or_else(|| json!("9:16")),
    );
    object.insert(
        "visual_style".into(),
        creation_spec
            .get("visual_style")
            .cloned()
            .unwrap_or_else(|| json!("电影级统一视觉风格")),
    );
    Ok(story)
}

fn normalize_episodes(mut episodes: Vec<Value>, duration: f64) -> Result<Vec<Value>, String> {
    if episodes.is_empty() {
        return Err(workflow_error(
            "GUIDED_IDEA_EPISODES_INVALID",
            "至少需要一个分集",
        ));
    }
    let per_episode = duration / episodes.len() as f64;
    if !(60.0..=120.0).contains(&per_episode) && !(episodes.len() == 1 && duration < 60.0) {
        return Err(workflow_error(
            "GUIDED_IDEA_EPISODES_INVALID",
            "每集时长必须约为1至2分钟",
        ));
    }
    for (index, episode) in episodes.iter_mut().enumerate() {
        let object = episode
            .as_object_mut()
            .ok_or_else(|| workflow_error("GUIDED_IDEA_EPISODES_INVALID", "分集数据不是对象"))?;
        object.insert("id".into(), json!(format!("EP_{:03}", index + 1)));
        object.insert("order".into(), json!(index + 1));
        object.insert("duration".into(), json!(per_episode));
        ensure_text(object, "title", &format!("第{}集", index + 1));
        let content = object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if content.chars().count() < 30 || is_placeholder(content) {
            return Err(workflow_error(
                "GUIDED_IDEA_EPISODES_INVALID",
                format!("第{}集缺少具体剧情内容", index + 1),
            ));
        }
    }
    Ok(episodes)
}

fn normalize_assets(mut raw: Value) -> Result<Value, String> {
    let characters = raw
        .get_mut("characters")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_INVALID", "缺少characters数组"))?;
    if characters.is_empty() {
        return Err(workflow_error(
            "GUIDED_IDEA_ASSETS_INVALID",
            "至少需要一个角色",
        ));
    }
    for (index, character) in characters.iter_mut().enumerate() {
        let object = character
            .as_object_mut()
            .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_INVALID", "角色数据不是对象"))?;
        object.insert("id".into(), json!(format!("CHAR_{:03}", index + 1)));
        for (key, fallback) in [
            ("name", "未命名角色"),
            ("role", "剧情角色"),
            ("gender", "未指定"),
            ("age_range", "未指定"),
            ("voice", "符合人物设定的声音"),
            ("story_function", "推动剧情发展"),
        ] {
            ensure_text(object, key, fallback);
        }
        let appearance_value = object.remove("appearance");
        let mut appearance = match appearance_value {
            Some(Value::Object(value)) => value,
            Some(Value::String(value)) => Map::from_iter([("face".to_owned(), json!(value))]),
            _ => Map::new(),
        };
        for (key, fallback) in [
            ("face", "五官清晰且有辨识度"),
            ("hair", "明确且固定的发型"),
            ("body", "自然人体比例"),
            ("clothes", "符合身份且跨镜头固定的服装"),
            ("accessories", "无"),
        ] {
            ensure_text(&mut appearance, key, fallback);
        }
        object.insert("appearance".into(), Value::Object(appearance));
        normalize_character_states(object, index);
        object
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        object.entry("locked").or_insert(json!(false));
    }
    let scenes = raw
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_INVALID", "缺少scenes数组"))?;
    if scenes.is_empty() {
        return Err(workflow_error(
            "GUIDED_IDEA_ASSETS_INVALID",
            "至少需要一个场景",
        ));
    }
    for (index, scene) in scenes.iter_mut().enumerate() {
        let object = scene
            .as_object_mut()
            .ok_or_else(|| workflow_error("GUIDED_IDEA_ASSETS_INVALID", "场景数据不是对象"))?;
        object.insert("id".into(), json!(format!("SCENE_{:03}", index + 1)));
        for (key, fallback) in [
            ("name", "未命名场景"),
            ("location_type", "按空间设定"),
            ("time_of_day", "按剧情时间"),
            ("lighting", "符合场景氛围的具体光线"),
            ("layout", "出入口与主体区域关系清晰"),
            ("mood", "符合本场剧情情绪"),
        ] {
            ensure_text(object, key, fallback);
        }
        let description = object
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if description.chars().count() < 15 || is_placeholder(description) {
            return Err(workflow_error(
                "GUIDED_IDEA_ASSETS_INVALID",
                format!(
                    "场景“{}”缺少详细空间描述",
                    object
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名")
                ),
            ));
        }
        object.entry("props").or_insert_with(|| json!([]));
        object
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        object.entry("locked").or_insert(json!(false));
    }
    crate::character_state_policy::normalize(&mut raw);
    Ok(raw)
}

fn normalize_character_states(character: &mut Map<String, Value>, character_index: usize) {
    let character_id = format!("CHAR_{:03}", character_index + 1);
    let appearance_lock = character
        .get("appearance_lock")
        .and_then(Value::as_str)
        .unwrap_or("五官、发型和体态保持一致")
        .to_owned();
    let clothing_lock = character
        .get("clothing_lock")
        .and_then(Value::as_str)
        .or_else(|| {
            character
                .get("appearance")
                .and_then(|appearance| appearance.get("clothes"))
                .and_then(Value::as_str)
        })
        .unwrap_or("服装与配饰保持一致")
        .to_owned();
    let mut states = character
        .remove("states")
        .and_then(|value| value.as_array().cloned())
        .filter(|states| !states.is_empty())
        .unwrap_or_else(|| states_from_lock_text(&appearance_lock, &clothing_lock));
    if states.is_empty() {
        states.push(json!({
            "name":"默认状态",
            "trigger":"角色常规出场",
            "description":format!("{appearance_lock}；{clothing_lock}"),
            "appearance_lock":appearance_lock,
            "clothing_lock":clothing_lock
        }));
    }
    for (state_index, state) in states.iter_mut().enumerate() {
        if !state.is_object() {
            *state = json!({});
        }
        let object = state.as_object_mut().expect("state normalized to object");
        object.insert(
            "id".into(),
            json!(format!("{character_id}_STATE_{:03}", state_index + 1)),
        );
        ensure_text(object, "name", &format!("状态{}", state_index + 1));
        ensure_text(object, "trigger", "处于该形态对应的剧情阶段");
        ensure_text(
            object,
            "description",
            &format!("{appearance_lock}；{clothing_lock}"),
        );
        ensure_text(object, "appearance_lock", &appearance_lock);
        ensure_text(object, "clothing_lock", &clothing_lock);
        object
            .entry("reference_assets")
            .or_insert_with(|| json!([]));
        object.entry("locked").or_insert(json!(false));
    }
    character.insert("states".into(), Value::Array(states));
}

fn states_from_lock_text(appearance_lock: &str, clothing_lock: &str) -> Vec<Value> {
    let clauses = clothing_lock
        .split(['；', ';', '\n'])
        .map(str::trim)
        .filter(|clause| !clause.is_empty() && clause.contains("状态"))
        .collect::<Vec<_>>();
    if clauses.len() < 2 {
        return Vec::new();
    }
    clauses
        .into_iter()
        .map(|clause| {
            let state_prefix = clause
                .split_once("状态")
                .map(|(prefix, _)| prefix)
                .unwrap_or("角色");
            let name = format!(
                "{}状态",
                state_prefix.trim().trim_start_matches(['，', '。'])
            );
            json!({
                "name":name,
                "trigger":format!("剧情进入{name}"),
                "description":format!("{appearance_lock}；{clause}"),
                "appearance_lock":appearance_lock,
                "clothing_lock":clause
            })
        })
        .collect()
}

fn validate_meaningful_storyboard(value: Value) -> Result<Value, String> {
    let shots = value
        .get("shots")
        .and_then(Value::as_array)
        .ok_or_else(|| "分镜结果缺少shots数组".to_owned())?;
    let mut fingerprints = HashSet::new();
    let mut prompt_fingerprints = HashSet::new();
    for (index, shot) in shots.iter().enumerate() {
        let visual = shot
            .get("visual")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let action = shot
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let camera = shot
            .get("camera_movement")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let video_prompt = shot
            .get("video_prompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if visual.chars().count() < 20
            || action.chars().count() < 6
            || is_placeholder(visual)
            || is_placeholder(action)
            || is_placeholder(camera)
            || is_placeholder(video_prompt)
        {
            return Err(format!(
                "第{}个分镜缺少具体画面或动作，不能使用模板占位内容",
                index + 1
            ));
        }
        let fingerprint = format!("{visual}\n{action}");
        if !fingerprints.insert(fingerprint) {
            return Err(format!("第{}个分镜与前面的分镜内容完全重复", index + 1));
        }
        if !prompt_fingerprints.insert(video_prompt.to_owned()) {
            return Err(format!(
                "第{}个分镜的视频提示词与前面的分镜完全重复",
                index + 1
            ));
        }
    }
    Ok(value)
}

fn enrich_episode_segment(mut value: Value, episode: &Value) -> Value {
    let summary = value
        .get("episode_summary")
        .cloned()
        .or_else(|| episode.get("content").cloned())
        .unwrap_or(Value::Null);
    value["segment_summary"] = summary.clone();
    value["sequence"]["summary"] = summary;
    let character_ids = value
        .get("shots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|shot| {
            shot.get("character_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<HashSet<_>>()
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();
    value["sequence"]["character_ids"] = Value::Array(character_ids);
    value
}

fn is_placeholder(value: &str) -> bool {
    [
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

fn episode_count(duration: f64) -> usize {
    let minimum = (duration / 120.0).ceil() as usize;
    let maximum = (duration / 60.0).floor().max(1.0) as usize;
    ((duration / DEFAULT_EPISODE_SECONDS).round().max(1.0) as usize)
        .clamp(minimum.max(1), maximum.max(minimum.max(1)))
}

fn target_duration(creation_spec: &Value) -> f64 {
    creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(600.0)
        .clamp(5.0, 3600.0)
}

fn payload_value(payload: &Value, key: &str) -> Value {
    payload.get(key).cloned().unwrap_or_else(|| payload.clone())
}

fn payload_array(payload: &Value, key: &str) -> Result<Vec<Value>, String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| workflow_error("GUIDED_IDEA_PAYLOAD_INVALID", format!("缺少{key}数组")))
}

fn ensure_text(object: &mut Map<String, Value>, key: &str, fallback: &str) {
    if object
        .get(key)
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        object.insert(key.to_owned(), json!(fallback));
    }
}

fn update_running(
    project_path: &PathBuf,
    workflow_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
    snapshot: &Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
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
    )
}

fn update_waiting(
    project_path: &PathBuf,
    workflow_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
    snapshot: &Value,
) -> Result<database::idea_workflows::IdeaDevelopmentWorkflow, String> {
    let connection = database::open(project_path)?;
    database::idea_workflows::update(
        &connection,
        workflow_id,
        "WAITING_INPUT",
        stage,
        progress,
        message,
        snapshot,
        None,
    )
}

fn fail_workflow(
    project_path: &PathBuf,
    workflow_id: &str,
    stage: &str,
    snapshot: &Value,
    error: &str,
) {
    if let Ok(connection) = database::open(project_path) {
        let current = database::idea_workflows::get(&connection, workflow_id)
            .ok()
            .flatten();
        let failed_stage = current
            .as_ref()
            .map(|workflow| workflow.stage.as_str())
            .unwrap_or(stage);
        let progress = current
            .as_ref()
            .map(|workflow| workflow.progress)
            .unwrap_or(0.0);
        let error_value = serde_json::from_str(error).unwrap_or_else(
            |_| json!({"code":"GUIDED_IDEA_ERROR","message":error,"retryable":true}),
        );
        let message = error_value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("创意分步流程当前步骤失败");
        let _ = database::idea_workflows::update(
            &connection,
            workflow_id,
            "FAILED",
            failed_stage,
            progress,
            message,
            snapshot,
            Some(&error_value),
        );
    }
}

fn workflow_error(code: &str, message: impl Into<String>) -> String {
    json!({"code":code,"message":message.into(),"retryable":true}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_count_keeps_each_episode_between_one_and_two_minutes() {
        for duration in [60.0, 120.0, 180.0, 181.0, 300.0, 601.0, 1800.0, 3600.0] {
            let count = episode_count(duration);
            let each = duration / count as f64;
            assert!((60.0..=120.0).contains(&each));
        }
    }

    #[test]
    fn short_idea_uses_one_short_episode() {
        assert_eq!(episode_count(5.0), 1);
        assert_eq!(episode_count(59.0), 1);
        assert!(normalize_episodes(
            vec![json!({"title":"短片", "content":"主角在极短时间内完成一个具体行动，并以清晰结果结束整个故事。"})],
            30.0,
        )
        .is_ok());
    }

    #[test]
    fn rejects_placeholder_storyboards() {
        let result = validate_meaningful_storyboard(
            json!({"shots":[{"visual":"按当前剧情大纲呈现画面，人物进入场景","action":"人物按剧情自然行动"}]}),
        );
        assert!(result.is_err());
    }

    #[test]
    fn extracts_multiple_states_from_a_combined_character_lock() {
        let normalized = normalize_assets(json!({
            "characters":[{
                "name":"孙小野",
                "appearance":{"face":"年轻东方男性","hair":"黑色短发","body":"精瘦","clothes":"深蓝外卖夹克","accessories":"保温箱"},
                "appearance_lock":"年轻东方男性，黑色短发和精瘦体态保持一致",
                "clothing_lock":"凡人状态固定为深蓝外卖防风夹克、黑色长裤、运动鞋、红黑外卖保温箱；神变状态固定叠加金色齐天战甲，不使用现代军装或其他英雄制服"
            }],
            "scenes":[{
                "name":"餐馆",
                "description":"冷白顶灯照亮狭长过道，玻璃门连接雨夜街道，柜台和散落餐盘形成明确空间层次"
            }]
        }))
        .unwrap();
        let states = normalized["characters"][0]["states"].as_array().unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0]["name"], "凡人状态");
        assert_eq!(states[1]["name"], "神变状态");
        assert_eq!(states[1]["id"], "CHAR_001_STATE_002");
    }
}
