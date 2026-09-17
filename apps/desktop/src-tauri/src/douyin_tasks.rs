use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, time::Duration};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDouyinUnderstandingTaskInput {
    share_text: String,
    prompt: String,
    source_width: Option<u64>,
    source_height: Option<u64>,
    aspect_ratio: Option<String>,
    #[serde(default)]
    managed: bool,
    browser_cookie_source: Option<String>,
    cookie_file_path: Option<String>,
    #[serde(default)]
    video_info: Value,
    mode: String,
    fixed_seconds: Option<u64>,
    #[serde(default = "default_video_submission_mode")]
    video_submission_mode: String,
    #[serde(default)]
    long_video_confirmed: bool,
    #[serde(default)]
    provider_model_id: Option<String>,
    #[serde(default)]
    expected_credits: Option<f64>,
    #[serde(default = "default_extraction_billing_mode")]
    extraction_billing_mode: String,
    #[serde(default)]
    platform_api_base_url: Option<String>,
}

fn default_video_submission_mode() -> String {
    // Tasks created by an older client used the download/upload path. Keeping
    // that default also makes retries of persisted tasks backward compatible.
    "upload".to_owned()
}

fn default_extraction_billing_mode() -> String {
    "OVERALL".to_owned()
}

const LONG_VIDEO_THRESHOLD_SECONDS: f64 = 5.0 * 60.0;
const LONG_VIDEO_SEGMENT_SECONDS: f64 = 5.0 * 60.0;

fn long_video_segment_count(duration: f64) -> usize {
    if duration > LONG_VIDEO_THRESHOLD_SECONDS {
        (duration / LONG_VIDEO_SEGMENT_SECONDS).ceil() as usize
    } else {
        1
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveLocalVideoUnderstandingTaskInput {
    video_path: String,
    mode: String,
    fixed_seconds: Option<u64>,
    duration: Option<f64>,
    aspect_ratio: Option<String>,
    result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLocalVideoUnderstandingTaskInput {
    video_path: String,
    prompt: String,
    mode: String,
    fixed_seconds: Option<u64>,
    #[serde(default)]
    platform_api_base_url: Option<String>,
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
            "CREATE TABLE IF NOT EXISTS douyin_understanding_tasks (
                id TEXT PRIMARY KEY,
                share_text TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                uploader TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT 'UNKNOWN',
                thumbnail TEXT,
                duration REAL,
                width INTEGER,
                height INTEGER,
                aspect_ratio TEXT,
                mode TEXT NOT NULL,
                fixed_seconds INTEGER,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                input_json TEXT NOT NULL,
                result_json TEXT,
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                source_kind TEXT NOT NULL DEFAULT 'LINK'
            );
            CREATE INDEX IF NOT EXISTS idx_douyin_understanding_tasks_created
                ON douyin_understanding_tasks(created_at DESC);",
        )
        .map_err(|error| error.to_string())?;
    crate::platform_session::bind_user_owned_tables(&connection, &["douyin_understanding_tasks"])?;
    let has_platform = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('douyin_understanding_tasks') WHERE name = 'platform'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        > 0;
    if !has_platform {
        connection
            .execute(
                "ALTER TABLE douyin_understanding_tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'UNKNOWN'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    let has_source_kind = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('douyin_understanding_tasks') WHERE name = 'source_kind'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        > 0;
    if !has_source_kind {
        connection
            .execute(
                "ALTER TABLE douyin_understanding_tasks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'LINK'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(connection)
}

fn value_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn normalized_fixed_seconds(mode: &str, fixed_seconds: Option<u64>) -> Result<Option<u64>, String> {
    if mode != "fixed" {
        return Ok(None);
    }
    match fixed_seconds.unwrap_or(10) {
        seconds @ (6 | 10 | 15) => Ok(Some(seconds)),
        _ => Err("固定分镜时长只能选择 6、10 或 15 秒".to_owned()),
    }
}

fn video_mime_type(extension: &str) -> &'static str {
    match extension {
        "mov" => "video/mov",
        "webm" => "video/webm",
        "mpeg" | "mpg" => "video/mpeg",
        "avi" => "video/avi",
        "wmv" => "video/wmv",
        "3gp" => "video/3gpp",
        _ => "video/mp4",
    }
}

fn finish_completed(
    app: &tauri::AppHandle,
    task_id: &str,
    result: &crate::ai::VideoUnderstandingResult,
) {
    if let (Ok(connection), Ok(result_json)) = (open(app), serde_json::to_string(result)) {
        let now = Utc::now().to_rfc3339();
        let _ = connection.execute(
            "UPDATE douyin_understanding_tasks SET status = 'COMPLETED', stage = 'completed',
             progress = 1, message = '视频理解与分镜生成完成', result_json = ?2,
             error_json = NULL, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
            params![task_id, result_json, now],
        );
    }
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let result_json: Option<String> = row.get(16)?;
    let error_json: Option<String> = row.get(17)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "share_text": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
        "uploader": row.get::<_, String>(3)?,
        "platform": row.get::<_, String>(4)?,
        "thumbnail": row.get::<_, Option<String>>(5)?,
        "duration": row.get::<_, Option<f64>>(6)?,
        "width": row.get::<_, Option<u64>>(7)?,
        "height": row.get::<_, Option<u64>>(8)?,
        "aspect_ratio": row.get::<_, Option<String>>(9)?,
        "mode": row.get::<_, String>(10)?,
        "fixed_seconds": row.get::<_, Option<u64>>(11)?,
        "status": row.get::<_, String>(12)?,
        "stage": row.get::<_, String>(13)?,
        "progress": row.get::<_, f64>(14)?,
        "message": row.get::<_, String>(15)?,
        "result": result_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "error": error_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "created_at": row.get::<_, String>(18)?,
        "updated_at": row.get::<_, String>(19)?,
        "finished_at": row.get::<_, Option<String>>(20)?,
        "source_kind": row.get::<_, String>(21)?,
    }))
}

const SELECT_TASK: &str =
    "SELECT id, share_text, title, uploader, platform, thumbnail, duration, width, height,
    aspect_ratio, mode, fixed_seconds, status, stage, progress, message, result_json, error_json,
    created_at, updated_at, finished_at, source_kind FROM douyin_understanding_tasks";

fn get_task(app: &tauri::AppHandle, task_id: &str) -> Result<Value, String> {
    let connection = open(app)?;
    connection
        .query_row(
            &format!("{SELECT_TASK} WHERE id = ?1"),
            [task_id],
            task_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "视频理解任务不存在".to_owned())
}

fn update_progress(
    app: &tauri::AppHandle,
    task_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
) {
    if let Ok(connection) = open(app) {
        let _ = connection.execute(
            "UPDATE douyin_understanding_tasks SET status = 'RUNNING', stage = ?2, progress = ?3,
             message = ?4, updated_at = ?5 WHERE id = ?1",
            params![task_id, stage, progress, message, Utc::now().to_rfc3339()],
        );
    }
}

fn completed_worker_download(
    events: Vec<crate::worker::python::WorkerEvent>,
) -> Result<(), String> {
    for event in events {
        match event {
            crate::worker::python::WorkerEvent::Result(_) => return Ok(()),
            crate::worker::python::WorkerEvent::Error(error) => return Err(error.to_string()),
            crate::worker::python::WorkerEvent::Progress { .. } => {}
        }
    }
    Err(json!({
        "code": "VIDEO_DOWNLOAD_EMPTY_RESULT",
        "message": "视频下载器没有返回结果",
        "retryable": true
    })
    .to_string())
}

fn video_duration_is_complete(actual: f64, expected: Option<f64>) -> bool {
    let Some(expected) = expected.filter(|value| value.is_finite() && *value > 0.0) else {
        return actual.is_finite() && actual > 0.0;
    };
    let tolerance = (expected * 0.01).max(2.0);
    actual.is_finite() && actual + tolerance >= expected
}

async fn resolve_link_video(
    app: &tauri::AppHandle,
    input: &CreateDouyinUnderstandingTaskInput,
) -> Result<Value, String> {
    let share_text = input.share_text.clone();
    let managed = input.managed;
    let browser_cookie_source = input.browser_cookie_source.clone();
    let cookie_file_path = input.cookie_file_path.clone();
    let profile_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("douyin-managed-chrome");
    let resolve = tauri::async_runtime::spawn_blocking(move || {
        let events = if managed {
            crate::worker::python::resolve_douyin_auto(&share_text, &profile_root)?
        } else {
            crate::worker::python::resolve_douyin(
                &share_text,
                browser_cookie_source.as_deref(),
                cookie_file_path.as_deref(),
            )?
        };
        for event in events {
            match event {
                crate::worker::python::WorkerEvent::Result(value) => return Ok(value),
                crate::worker::python::WorkerEvent::Error(error) => {
                    return Err(error.to_string())
                }
                crate::worker::python::WorkerEvent::Progress { .. } => {}
            }
        }
        Err(json!({
            "code": "VIDEO_LINK_EMPTY_RESULT",
            "message": "自动识别与解析没有返回视频信息",
            "retryable": true
        })
        .to_string())
    });
    match tokio::time::timeout(Duration::from_secs(10 * 60), resolve).await {
        Ok(result) => result.map_err(|error| format!("视频链接自动识别任务异常：{error}"))?,
        Err(_) => Err(json!({
            "code": "VIDEO_LINK_RESOLVE_TIMEOUT",
            "message": "自动识别与解析视频链接超过 10 分钟，任务已停止，积分不会扣除或会自动回补。",
            "retryable": true
        })
        .to_string()),
    }
}

fn save_resolved_video(
    app: &tauri::AppHandle,
    task_id: &str,
    input: &CreateDouyinUnderstandingTaskInput,
) -> Result<(), String> {
    let connection = open(app)?;
    let input_json = serde_json::to_string(input).map_err(|error| error.to_string())?;
    let title = value_text(&input.video_info, "title");
    let uploader = value_text(&input.video_info, "uploader");
    let platform = match value_text(&input.video_info, "platform") {
        value if value.is_empty() => "UNKNOWN".to_owned(),
        value => value,
    };
    connection
        .execute(
            "UPDATE douyin_understanding_tasks SET title = ?2, uploader = ?3, platform = ?4,
             thumbnail = ?5, duration = ?6, width = ?7, height = ?8, aspect_ratio = ?9,
             input_json = ?10, updated_at = ?11 WHERE id = ?1",
            params![
                task_id,
                title,
                uploader,
                platform,
                input.video_info.get("thumbnail").and_then(Value::as_str),
                input.video_info.get("duration").and_then(Value::as_f64),
                input.video_info.get("width").and_then(Value::as_u64),
                input.video_info.get("height").and_then(Value::as_u64),
                input.aspect_ratio,
                input_json,
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn link_analysis_prompt(input: &CreateDouyinUnderstandingTaskInput) -> Result<String, String> {
    let aspect_ratio = match input.aspect_ratio.as_deref() {
        Some("9:16") => Some("9:16"),
        Some("16:9") => Some("16:9"),
        Some(_) => return Err("视频画面比例必须是 9:16 或 16:9".to_owned()),
        None => match (input.source_width, input.source_height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                Some(if width > height { "16:9" } else { "9:16" })
            }
            _ => None,
        },
    };
    let mut prompt = if let Some(aspect_ratio) = aspect_ratio {
        let resolution = match (input.source_width, input.source_height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => format!("{width}×{height}"),
            _ => "未提供".to_owned(),
        };
        format!(
            "{}\n\n【原视频权威元数据】\n原视频分辨率：{}\n原视频画面比例：{}\n以上比例已由下载器读取的视频宽高确定。项目剧情与每一个分镜的“屏幕比例”都必须严格输出为 {}，不得根据画面内容重新猜测或改写。",
            input.prompt.trim(), resolution, aspect_ratio, aspect_ratio
        )
    } else {
        input.prompt.trim().to_owned()
    };
    if let Some(seconds) = normalized_fixed_seconds(&input.mode, input.fixed_seconds)? {
        if let Some(duration) = input
            .video_info
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| *value > 0.0)
        {
            let shot_count = (duration / seconds as f64).ceil() as u64;
            prompt.push_str(&format!(
                "\n\n【固定分镜权威时长】\n原视频真实时长为 {duration:.3} 秒。必须生成 {shot_count} 个分镜；分镜标题用于定位原片，最后一段标题结束于原视频真实结尾。每段标题下一行必须输出“生成时长：{seconds}秒”，且每个分镜（包括最后一个）的生成时长都恰好为 {seconds} 秒。最后一个分镜不足的部分只保持最后一个有意义的画面状态，不得新增剧情、台词、人物或动作。"
            ));
        }
    }
    Ok(prompt)
}

fn long_video_segment_prompt(
    base_prompt: &str,
    index: usize,
    count: usize,
    start: f64,
    duration: f64,
    total_duration: f64,
) -> String {
    format!(
        "{base_prompt}\n\n【长视频分段分析规则（最高优先级，覆盖前文冲突要求）】\n完整原视频时长为 {total_duration:.3} 秒，本文件是第 {current}/{count} 段，覆盖原片 {start:.3}～{end:.3} 秒。只分析本文件中真实存在的内容，不得分析或虚构其他片段。分镜标题的时间轴必须从本片段的 0 秒开始，连续覆盖到 {duration:.3} 秒；不要在标题中叠加原片偏移，客户端会在合并时统一换算为全片时间。仍须输出完整的“一、项目剧情、二、全局角色库、三、全局场景库、四、分镜列表”四个部分。固定秒数模式也只生成覆盖当前片段的分镜。",
        current = index + 1,
        end = start + duration,
    )
}

#[derive(Default)]
struct StoryboardSections {
    project: String,
    characters: String,
    scenes: String,
    shots: String,
}

fn content_after_heading<'a>(value: &'a str, heading: &str) -> &'a str {
    value
        .strip_prefix(heading)
        .unwrap_or(value)
        .trim_start_matches(['\r', '\n', ' '])
}

fn split_storyboard_sections(text: &str) -> Option<StoryboardSections> {
    let project_index = text.find("一、项目剧情")?;
    let characters_index = text[project_index..].find("二、全局角色库")? + project_index;
    let scenes_index = text[characters_index..].find("三、全局场景库")? + characters_index;
    let shots_index = text[scenes_index..].find("四、分镜列表")? + scenes_index;
    Some(StoryboardSections {
        project: content_after_heading(&text[project_index..characters_index], "一、项目剧情")
            .trim()
            .to_owned(),
        characters: content_after_heading(
            &text[characters_index..scenes_index],
            "二、全局角色库",
        )
        .trim()
        .to_owned(),
        scenes: content_after_heading(&text[scenes_index..shots_index], "三、全局场景库")
            .trim()
            .to_owned(),
        shots: content_after_heading(&text[shots_index..], "四、分镜列表")
            .trim()
            .to_owned(),
    })
}

fn entry_blocks(section: &str, marker: &str) -> Vec<String> {
    let starts = section
        .match_indices(marker)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if starts.is_empty() {
        return if section.trim().is_empty() {
            Vec::new()
        } else {
            vec![section.trim().to_owned()]
        };
    }
    starts
        .iter()
        .enumerate()
        .map(|(position, start)| {
            let end = starts.get(position + 1).copied().unwrap_or(section.len());
            section[*start..end].trim().to_owned()
        })
        .collect()
}

fn numeric_id_after(value: &str, prefix: &str) -> Option<String> {
    let start = value.find(prefix)?;
    let rest = &value[start..];
    let digits = rest[prefix.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    (digits > 0).then(|| rest[..prefix.len() + digits].to_owned())
}

fn catalog_name(block: &str) -> String {
    block
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("名称：")
                .or_else(|| line.trim().strip_prefix("名称:"))
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn merge_catalog(
    section: &str,
    marker: &str,
    prefix: &str,
    known_names: &mut HashMap<String, String>,
    next_id: &mut usize,
) -> (Vec<String>, HashMap<String, String>) {
    let mut kept = Vec::new();
    let mut mapping = HashMap::new();
    for block in entry_blocks(section, marker) {
        let Some(old_id) = numeric_id_after(&block, prefix) else {
            kept.push(block);
            continue;
        };
        let name = catalog_name(&block);
        let normalized_name = name.trim().to_lowercase();
        let (new_id, is_new) = if !normalized_name.is_empty() {
            if let Some(existing) = known_names.get(&normalized_name) {
                (existing.clone(), false)
            } else {
                let value = format!("{prefix}{:03}", *next_id);
                *next_id += 1;
                known_names.insert(normalized_name, value.clone());
                (value, true)
            }
        } else {
            let value = format!("{prefix}{:03}", *next_id);
            *next_id += 1;
            (value, true)
        };
        mapping.insert(old_id.clone(), new_id.clone());
        if is_new {
            kept.push(block.replace(&old_id, &new_id));
        }
    }
    (kept, mapping)
}

fn replace_ids(mut value: String, mapping: &HashMap<String, String>) -> String {
    let mut entries = mapping.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(old, _)| std::cmp::Reverse(old.len()));
    for (old, new) in entries {
        value = value.replace(old, new);
    }
    value
}

fn format_time(value: f64) -> String {
    if (value - value.round()).abs() < 0.001 {
        format!("{:.0}", value)
    } else {
        format!("{value:.3}").trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

fn offset_shot_titles(value: &str, offset: f64, next_shot: &mut usize) -> String {
    value
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            let Some(open) = trimmed.find('（') else {
                return line.to_owned();
            };
            if !trimmed.starts_with('第') || !trimmed[..open].ends_with('段') {
                return line.to_owned();
            }
            let Some(close_relative) = trimmed[open + '（'.len_utf8()..].find("秒）") else {
                return line.to_owned();
            };
            let close = open + '（'.len_utf8() + close_relative;
            let range = &trimmed[open + '（'.len_utf8()..close];
            let Some((start_text, end_text)) = range
                .split_once('～')
                .or_else(|| range.split_once('~'))
                .or_else(|| range.split_once('-'))
            else {
                return line.to_owned();
            };
            let (Ok(start), Ok(end)) = (
                start_text.trim().parse::<f64>(),
                end_text.trim().parse::<f64>(),
            ) else {
                return line.to_owned();
            };
            let already_global = offset > 0.0 && start >= offset - 0.5;
            let actual_offset = if already_global { 0.0 } else { offset };
            let replacement = format!(
                "第{}段（{}～{}秒）",
                *next_shot,
                format_time(start + actual_offset),
                format_time(end + actual_offset)
            );
            *next_shot += 1;
            replacement
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn story_summary(project: &str) -> String {
    project
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("故事概要：")
                .or_else(|| line.trim().strip_prefix("故事概要:"))
        })
        .unwrap_or("未单独输出概要，完整内容见本段分镜。")
        .trim()
        .to_owned()
}

fn merge_long_video_results(
    results: &[crate::ai::VideoUnderstandingResult],
    segment_durations: &[f64],
    total_duration: f64,
    video_name: String,
    size_bytes: u64,
) -> Result<crate::ai::VideoUnderstandingResult, String> {
    if results.is_empty() || results.len() != segment_durations.len() {
        return Err("长视频分段解析结果不完整，无法合并".to_owned());
    }
    let mut first_project = String::new();
    let mut character_blocks = Vec::new();
    let mut scene_blocks = Vec::new();
    let mut shot_blocks = Vec::new();
    let mut summaries = Vec::new();
    let mut character_names = HashMap::new();
    let mut scene_names = HashMap::new();
    let mut next_character = 1;
    let mut next_scene = 1;
    let mut next_shot = 1;
    let mut offset = 0.0;

    for (index, (result, duration)) in results.iter().zip(segment_durations).enumerate() {
        let Some(sections) = split_storyboard_sections(&result.text) else {
            summaries.push(format!(
                "- 第 {} 段（{}～{}秒）：模型未单独输出分段概要，完整原文已保留在分镜列表中。",
                index + 1,
                format_time(offset),
                format_time((offset + duration).min(total_duration)),
            ));
            shot_blocks.push(offset_shot_titles(&result.text, offset, &mut next_shot));
            offset += duration;
            continue;
        };
        if first_project.is_empty() {
            first_project = sections.project.clone();
        }
        summaries.push(format!(
            "- 第 {} 段（{}～{}秒）：{}",
            index + 1,
            format_time(offset),
            format_time((offset + duration).min(total_duration)),
            story_summary(&sections.project)
        ));
        let (characters, character_mapping) = merge_catalog(
            &sections.characters,
            "【角色 ",
            "CHAR_",
            &mut character_names,
            &mut next_character,
        );
        let (scenes, scene_mapping) = merge_catalog(
            &sections.scenes,
            "【场景 ",
            "SCENE_",
            &mut scene_names,
            &mut next_scene,
        );
        character_blocks.extend(characters);
        scene_blocks.extend(scenes);
        let shots = replace_ids(
            replace_ids(sections.shots, &character_mapping),
            &scene_mapping,
        );
        shot_blocks.push(offset_shot_titles(&shots, offset, &mut next_shot));
        offset += duration;
    }

    if first_project.is_empty() {
        first_project = format!(
            "标题：{}\n主题：长视频内容解析\n基调：依据原视频\n一句话梗概：完整还原长视频各片段内容\n故事概要：各分段原始解析结果已按完整时间轴合并。",
            video_name.trim_end_matches(".mp4")
        );
    }
    let text = format!(
        "一、项目剧情\n{first_project}\n长视频处理：完整视频共 {} 秒，已下载并拆分为 {} 段逐段解析后合并。\n分段剧情概要：\n{}\n\n二、全局角色库\n{}\n\n三、全局场景库\n{}\n\n四、分镜列表\n{}",
        format_time(total_duration),
        results.len(),
        summaries.join("\n"),
        character_blocks.join("\n\n"),
        scene_blocks.join("\n\n"),
        shot_blocks.join("\n\n"),
    );
    Ok(crate::ai::VideoUnderstandingResult {
        text: crate::shot_policy::internalize_storyboard_dialogue_in_visual(&text),
        model: results[0].model.clone(),
        upload_mode: "server-upload-segmented".to_owned(),
        video_name,
        size_bytes,
    })
}

fn spawn_task(app: tauri::AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let input_json = open(&app).and_then(|connection| {
            connection
                .query_row(
                    "SELECT input_json FROM douyin_understanding_tasks WHERE id = ?1",
                    [&task_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())
        });
        let mut input = match input_json.and_then(|value| {
            serde_json::from_str::<CreateDouyinUnderstandingTaskInput>(&value)
                .map_err(|error| error.to_string())
        }) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let execution_key = uuid::Uuid::new_v4().to_string();
        if value_text(&input.video_info, "download_url").is_empty() {
            update_progress(
                &app,
                &task_id,
                "resolving",
                0.06,
                "正在自动识别视频平台并解析链接",
            );
            input.video_info = match resolve_link_video(&app, &input).await {
                Ok(value) => value,
                Err(error) => {
                    finish_failed(&app, &task_id, error);
                    return;
                }
            };
            if input.source_width.is_none() {
                input.source_width = input.video_info.get("width").and_then(Value::as_u64);
            }
            if input.source_height.is_none() {
                input.source_height = input.video_info.get("height").and_then(Value::as_u64);
            }
            if input.aspect_ratio.is_none() {
                input.aspect_ratio = match (input.source_width, input.source_height) {
                    (Some(width), Some(height)) if width > 0 && height > 0 => {
                        Some(if width > height { "16:9" } else { "9:16" }.to_owned())
                    }
                    _ => None,
                };
            }
            if let Err(error) = save_resolved_video(&app, &task_id, &input) {
                finish_failed(&app, &task_id, error);
                return;
            }
            update_progress(
                &app,
                &task_id,
                "preparing",
                0.14,
                "链接解析完成，正在准备视频理解与分镜生成",
            );
        }
        if input
            .video_info
            .get("duration")
            .and_then(Value::as_f64)
            .is_some_and(|duration| duration > LONG_VIDEO_THRESHOLD_SECONDS)
        {
            if !input.long_video_confirmed {
                finish_failed(
                    &app,
                    &task_id,
                    "已解析到视频超过 5 分钟，需要先由用户确认下载、分段解析和较长等待时间。请重新提交任务。".to_owned(),
                );
                return;
            }
            input.video_submission_mode = "upload".to_owned();
        }
        let ext = value_text(&input.video_info, "ext").to_ascii_lowercase();
        let prompt = match link_analysis_prompt(&input) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let title = value_text(&input.video_info, "title");
        let video_name = format!(
            "{}.{}",
            if title.is_empty() { "video" } else { &title },
            if ext.is_empty() { "mp4" } else { &ext }
        );
        if input.video_submission_mode == "url" {
            let video_url = value_text(&input.video_info, "download_url");
            let valid_url = reqwest::Url::parse(&video_url)
                .ok()
                .filter(|url| url.scheme() == "https");
            if valid_url.is_none() {
                update_progress(
                    &app,
                    &task_id,
                    "fallback",
                    0.3,
                    "极速模式地址无效，正在自动切换详细模式重试",
                );
            } else {
                update_progress(
                    &app,
                    &task_id,
                    "fast_analyzing",
                    0.24,
                    "正在分析理解视频",
                );
                let analysis = match (&input.provider_model_id, input.expected_credits) {
                    (Some(provider_model_id), Some(expected_credits)) => {
                        crate::platform_video_understanding::understand_public_url_confirmed(
                            input.platform_api_base_url.as_deref(),
                            &video_url,
                            video_mime_type(&ext),
                            &prompt,
                            video_name.clone(),
                            provider_model_id,
                            expected_credits,
                            &format!("{task_id}-{execution_key}-fast"),
                        )
                        .await
                    }
                    _ => crate::platform_video_understanding::understand_public_url(
                        input.platform_api_base_url.as_deref(),
                        &video_url,
                        video_mime_type(&ext),
                        &prompt,
                        video_name.clone(),
                    )
                    .await,
                };
                match analysis {
                    Ok(result) => {
                        finish_completed(&app, &task_id, &result);
                        return;
                    }
                    Err(_) => update_progress(
                        &app,
                        &task_id,
                        "fallback",
                        0.3,
                        "极速模式失败或超时，正在自动切换详细模式重试一次",
                    ),
                }
            }
        }
        let temp_dir = match app.path().app_cache_dir() {
            Ok(path) => path.join("video-understanding-upload"),
            Err(error) => {
                finish_failed(&app, &task_id, format!("无法定位视频缓存目录：{error}"));
                return;
            }
        };
        if let Err(error) = tokio::fs::create_dir_all(&temp_dir).await {
            finish_failed(&app, &task_id, format!("无法创建视频缓存目录：{error}"));
            return;
        }
        let downloaded_path =
            temp_dir.join(format!("{}-source.mp4", uuid::Uuid::new_v4().simple()));
        let compressed_path =
            temp_dir.join(format!("{}-compressed.mp4", uuid::Uuid::new_v4().simple()));
        let download_target = downloaded_path.clone();
        let share_text = input.share_text.clone();
        let managed = input.managed;
        let browser_cookie_source = input.browser_cookie_source.clone();
        let cookie_file_path = input.cookie_file_path.clone();
        let resolved_video_info = input.video_info.clone();
        let expected_download_duration = resolved_video_info
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0);
        let profile_root = match app.path().app_data_dir() {
            Ok(path) => path.join("douyin-managed-chrome"),
            Err(error) => {
                finish_failed(&app, &task_id, format!("无法定位浏览器登录目录：{error}"));
                return;
            }
        };

        update_progress(
            &app,
            &task_id,
            "downloading",
            0.4,
            "详细模式：正在下载真实视频并固化分析副本",
        );
        let download = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if !value_text(&resolved_video_info, "download_url").is_empty() {
                if let Ok(events) = crate::worker::python::download_resolved_video(
                    &resolved_video_info,
                    &download_target,
                    cookie_file_path.as_deref(),
                ) {
                    if completed_worker_download(events).is_ok() {
                        let direct_download_is_complete = crate::media_tools::probe_video_metadata(
                            &download_target,
                        )
                        .map(|metadata| {
                            video_duration_is_complete(
                                metadata.duration,
                                expected_download_duration,
                            )
                        })
                        .unwrap_or(false);
                        if direct_download_is_complete {
                            return Ok(());
                        }
                        let _ = fs::remove_file(&download_target);
                    }
                }
            }
            let events = if managed {
                crate::worker::python::download_douyin_auto(
                    &share_text,
                    &download_target,
                    &profile_root,
                )?
            } else {
                crate::worker::python::download_douyin(
                    &share_text,
                    &download_target,
                    browser_cookie_source.as_deref(),
                    cookie_file_path.as_deref(),
                )?
            };
            completed_worker_download(events)
        })
        .await;
        match download {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = tokio::fs::remove_file(&downloaded_path).await;
                finish_failed(&app, &task_id, error);
                return;
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&downloaded_path).await;
                finish_failed(&app, &task_id, format!("视频下载任务异常：{error}"));
                return;
            }
        }

        let downloaded_probe_path = downloaded_path.clone();
        let downloaded_metadata = tauri::async_runtime::spawn_blocking(move || {
            crate::media_tools::probe_video_metadata(&downloaded_probe_path)
        })
        .await;
        let downloaded_metadata = match downloaded_metadata {
            Ok(Ok(metadata)) => metadata,
            Ok(Err(error)) => {
                let _ = tokio::fs::remove_file(&downloaded_path).await;
                finish_failed(&app, &task_id, error);
                return;
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&downloaded_path).await;
                finish_failed(&app, &task_id, format!("视频有效性检查任务异常：{error}"));
                return;
            }
        };
        let downloaded_size = downloaded_metadata.size_bytes;
        let actual_duration = downloaded_metadata.duration;
        let expected_duration = input
            .video_info
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0);
        if !video_duration_is_complete(actual_duration, expected_duration) {
            let _ = tokio::fs::remove_file(&downloaded_path).await;
            finish_failed(
                &app,
                &task_id,
                json!({
                    "code": "VIDEO_DOWNLOAD_INCOMPLETE",
                    "message": format!(
                        "视频下载不完整：解析时长约 {} 秒，下载文件仅 {} 秒。已停止解析且不会提交不完整视频，请重试当前任务。",
                        format_time(expected_duration.unwrap_or_default()),
                        format_time(actual_duration)
                    ),
                    "retryable": true
                })
                .to_string(),
            );
            return;
        }
        let segment_count = long_video_segment_count(actual_duration);
        if segment_count > 1 && !input.long_video_confirmed {
            let _ = tokio::fs::remove_file(&downloaded_path).await;
            finish_failed(
                &app,
                &task_id,
                format!(
                    "下载校验后确认视频真实时长为 {}，超过 5 分钟。请重新提交并确认长视频分段解析与当前扣费模式。",
                    format_time(actual_duration)
                ),
            );
            return;
        }

        if segment_count > 1 {
            let segment_dir = temp_dir.join(format!(
                "{}-segments",
                uuid::Uuid::new_v4().simple()
            ));
            if let Err(error) = tokio::fs::create_dir_all(&segment_dir).await {
                let _ = tokio::fs::remove_file(&downloaded_path).await;
                finish_failed(&app, &task_id, format!("无法创建长视频分段目录：{error}"));
                return;
            }
            let mut segment_results = Vec::with_capacity(segment_count);
            let mut segment_durations = Vec::with_capacity(segment_count);
            let mut segment_error = None;
            for index in 0..segment_count {
                let start = index as f64 * LONG_VIDEO_SEGMENT_SECONDS;
                let duration = (actual_duration - start).min(LONG_VIDEO_SEGMENT_SECONDS);
                let segment_path = segment_dir.join(format!("part-{:03}.mp4", index + 1));
                update_progress(
                    &app,
                    &task_id,
                    "segmenting",
                    0.48 + 0.12 * index as f64 / segment_count as f64,
                    &format!(
                        "长视频共 {segment_count} 段，正在准备第 {} 段（{}～{}）",
                        index + 1,
                        format_time(start),
                        format_time((start + duration).min(actual_duration))
                    ),
                );
                let compression_source = downloaded_path.clone();
                let compression_target = segment_path.clone();
                let prepare = tauri::async_runtime::spawn_blocking(move || {
                    crate::media_tools::compress_video_segment_for_inline_analysis(
                        &compression_source,
                        &compression_target,
                        start,
                        duration,
                        crate::ai::LINGKE_INLINE_TARGET,
                    )
                })
                .await;
                match prepare {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        segment_error = Some(error);
                        break;
                    }
                    Err(error) => {
                        segment_error = Some(format!("长视频分段任务异常：{error}"));
                        break;
                    }
                }
                let validation_path = segment_path.clone();
                let segment_size = match tauri::async_runtime::spawn_blocking(move || {
                    crate::media_tools::probe_video_metadata(&validation_path)
                })
                .await
                {
                    Ok(Ok(metadata)) => metadata.size_bytes,
                    Ok(Err(error)) => {
                        segment_error = Some(error);
                        break;
                    }
                    Err(error) => {
                        segment_error = Some(format!("长视频分段有效性检查异常：{error}"));
                        break;
                    }
                };
                update_progress(
                    &app,
                    &task_id,
                    "segment_analyzing",
                    0.60 + 0.34 * index as f64 / segment_count as f64,
                    &format!(
                        "正在解析长视频第 {} / {} 段，请保持客户端运行且不要中途退出",
                        index + 1,
                        segment_count
                    ),
                );
                let segment_prompt = long_video_segment_prompt(
                    &prompt,
                    index,
                    segment_count,
                    start,
                    duration,
                    actual_duration,
                );
                let segment_name = format!("{}-第{}段.mp4", video_name, index + 1);
                let analysis = match (&input.provider_model_id, input.expected_credits) {
                    (Some(provider_model_id), Some(expected_credits)) => {
                        crate::platform_video_understanding::understand_uploaded_file_confirmed(
                            input.platform_api_base_url.as_deref(),
                            &segment_path,
                            &segment_prompt,
                            segment_name,
                            segment_size,
                            provider_model_id,
                            expected_credits,
                            &format!(
                                "{task_id}-{execution_key}-segment-{}-of-{segment_count}",
                                index + 1
                            ),
                            Some(crate::platform_video_understanding::VideoUnderstandingBilling {
                                group_id: &execution_key,
                                segment_index: index,
                                segment_count,
                                expected_mode: &input.extraction_billing_mode,
                            }),
                        )
                        .await
                    }
                    _ => Err("长视频分段缺少已确认的模型报价，请重新提交任务，本次没有继续扣分".to_owned()),
                };
                let _ = tokio::fs::remove_file(&segment_path).await;
                match analysis {
                    Ok(result) => {
                        segment_results.push(result);
                        segment_durations.push(duration);
                    }
                    Err(error) => {
                        segment_error = Some(error);
                        break;
                    }
                }
            }
            let _ = tokio::fs::remove_dir_all(&segment_dir).await;
            let _ = tokio::fs::remove_file(&downloaded_path).await;
            let _ = tokio::fs::remove_file(&compressed_path).await;
            if let Some(error) = segment_error {
                finish_failed(&app, &task_id, error);
                return;
            }
            update_progress(
                &app,
                &task_id,
                "merging",
                0.96,
                "所有视频片段解析完成，正在合并完整分镜、人物和场景",
            );
            match merge_long_video_results(
                &segment_results,
                &segment_durations,
                actual_duration,
                video_name,
                downloaded_size,
            ) {
                Ok(result) => finish_completed(&app, &task_id, &result),
                Err(error) => finish_failed(&app, &task_id, error),
            }
            return;
        }

        let mut analysis_path = downloaded_path.clone();
        if downloaded_size > crate::ai::LINGKE_INLINE_TARGET {
            update_progress(
                &app,
                &task_id,
                "compressing",
                0.58,
                "视频较大，正在压缩服务端分析副本",
            );
            let compression_source = downloaded_path.clone();
            let compression_target = compressed_path.clone();
            let compression = tauri::async_runtime::spawn_blocking(move || {
                crate::media_tools::compress_video_for_inline_analysis(
                    &compression_source,
                    &compression_target,
                    crate::ai::LINGKE_INLINE_TARGET,
                )
            })
            .await;
            match compression {
                Ok(Ok(())) => {
                    let validation_path = compressed_path.clone();
                    let validation = tauri::async_runtime::spawn_blocking(move || {
                        crate::media_tools::probe_video_metadata(&validation_path)
                    })
                    .await;
                    let validation_error = match validation {
                        Ok(Ok(_)) => None,
                        Ok(Err(error)) => Some(error),
                        Err(error) => Some(format!("压缩视频有效性检查任务异常：{error}")),
                    };
                    if let Some(error) = validation_error {
                        let _ = tokio::fs::remove_file(&downloaded_path).await;
                        let _ = tokio::fs::remove_file(&compressed_path).await;
                        finish_failed(&app, &task_id, error);
                        return;
                    }
                    analysis_path = compressed_path.clone();
                }
                Ok(Err(error)) => {
                    let _ = tokio::fs::remove_file(&downloaded_path).await;
                    let _ = tokio::fs::remove_file(&compressed_path).await;
                    finish_failed(&app, &task_id, error);
                    return;
                }
                Err(error) => {
                    let _ = tokio::fs::remove_file(&downloaded_path).await;
                    let _ = tokio::fs::remove_file(&compressed_path).await;
                    finish_failed(&app, &task_id, format!("视频压缩任务异常：{error}"));
                    return;
                }
            }
        }

        update_progress(
            &app,
            &task_id,
            "analyzing",
            0.74,
            "详细模式：正在上传视频并生成分镜，最长等待 10 分钟",
        );
        let analysis = match (&input.provider_model_id, input.expected_credits) {
            (Some(provider_model_id), Some(expected_credits)) => {
                crate::platform_video_understanding::understand_uploaded_file_confirmed(
                    input.platform_api_base_url.as_deref(),
                    &analysis_path,
                    &prompt,
                    video_name,
                    downloaded_size,
                    provider_model_id,
                    expected_credits,
                    &format!("{task_id}-{execution_key}-detailed"),
                    None,
                )
                .await
            }
            _ => crate::platform_video_understanding::understand_uploaded_file(
                input.platform_api_base_url.as_deref(),
                &analysis_path,
                &prompt,
                video_name,
                downloaded_size,
            )
            .await,
        };
        let _ = tokio::fs::remove_file(&downloaded_path).await;
        let _ = tokio::fs::remove_file(&compressed_path).await;
        match analysis {
            Ok(result) => finish_completed(&app, &task_id, &result),
            Err(error) => finish_failed(&app, &task_id, error),
        }
    });
}

fn spawn_local_task(app: tauri::AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let input_json = open(&app).and_then(|connection| {
            connection
                .query_row(
                    "SELECT input_json FROM douyin_understanding_tasks WHERE id = ?1 AND source_kind = 'LOCAL'",
                    [&task_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())
        });
        let input = match input_json.and_then(|value| {
            serde_json::from_str::<CreateLocalVideoUnderstandingTaskInput>(&value)
                .map_err(|error| error.to_string())
        }) {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, format!("本地视频任务参数损坏：{error}"));
                return;
            }
        };
        let source_path = PathBuf::from(&input.video_path);
        if !source_path.is_file() {
            finish_failed(&app, &task_id, "本地视频文件不存在或已经被移动".to_owned());
            return;
        }
        let probe_path = source_path.clone();
        let metadata = match tauri::async_runtime::spawn_blocking(move || {
            crate::media_tools::probe_video_metadata(&probe_path)
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                finish_failed(&app, &task_id, error);
                return;
            }
            Err(error) => {
                finish_failed(&app, &task_id, format!("本地视频有效性检查异常：{error}"));
                return;
            }
        };
        let original_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("video")
            .to_owned();
        let temp_dir = match app.path().app_cache_dir() {
            Ok(path) => path.join("video-understanding-upload"),
            Err(error) => {
                finish_failed(&app, &task_id, format!("无法定位视频缓存目录：{error}"));
                return;
            }
        };
        if let Err(error) = tokio::fs::create_dir_all(&temp_dir).await {
            finish_failed(&app, &task_id, format!("无法创建视频缓存目录：{error}"));
            return;
        }

        update_progress(&app, &task_id, "quoting", 0.06, "正在读取视频理解价格与扣费模式");
        let api_base = input.platform_api_base_url.as_deref().unwrap_or("");
        let quote = match crate::platform_media::quote(
            api_base,
            None,
            Some("VIDEO_UNDERSTANDING"),
            &json!({}),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                finish_failed(&app, &task_id, error);
                return;
            }
        };
        let provider_model_id = match quote.get("provider_model_id").and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() => value.to_owned(),
            _ => {
                finish_failed(&app, &task_id, "视频理解报价缺少模型信息，本次没有扣分".to_owned());
                return;
            }
        };
        let unit_credits = match quote.get("credits").and_then(Value::as_f64) {
            Some(value) if value.is_finite() && value >= 0.0 => value,
            _ => {
                finish_failed(&app, &task_id, "视频理解报价无效，本次没有扣分".to_owned());
                return;
            }
        };
        let billing_mode = quote
            .get("extraction_billing_mode")
            .and_then(Value::as_str)
            .unwrap_or("OVERALL")
            .to_ascii_uppercase();
        if !matches!(billing_mode.as_str(), "OVERALL" | "PER_SEGMENT") {
            finish_failed(&app, &task_id, "视频理解扣费模式无效，本次没有扣分".to_owned());
            return;
        }
        let segment_count = long_video_segment_count(metadata.duration);
        let charge_count = if billing_mode == "PER_SEGMENT" {
            segment_count
        } else {
            1
        };
        let mut confirmation_quote = quote.clone();
        confirmation_quote["credits"] = json!(unit_credits * charge_count as f64);
        confirmation_quote["unit_credits"] = json!(unit_credits);
        confirmation_quote["segment_count"] = json!(segment_count);
        confirmation_quote["charge_count"] = json!(charge_count);
        let operation = if segment_count > 1 {
            format!(
                "本地长视频理解与分镜解析（拆分 {segment_count} 段，{}）",
                if billing_mode == "PER_SEGMENT" { "分段单独扣费" } else { "整体仅扣一次" }
            )
        } else {
            "本地视频理解与分镜解析".to_owned()
        };
        if let Err(error) = crate::credit_confirmation::confirm(&operation, confirmation_quote).await {
            finish_failed(&app, &task_id, error);
            return;
        }

        let execution_key = uuid::Uuid::new_v4().to_string();
        if segment_count > 1 {
            let segment_dir = temp_dir.join(format!("{}-segments", uuid::Uuid::new_v4().simple()));
            if let Err(error) = tokio::fs::create_dir_all(&segment_dir).await {
                finish_failed(&app, &task_id, format!("无法创建长视频分段目录：{error}"));
                return;
            }
            let mut segment_results = Vec::with_capacity(segment_count);
            let mut segment_durations = Vec::with_capacity(segment_count);
            let mut segment_error = None;
            for index in 0..segment_count {
                let start = index as f64 * LONG_VIDEO_SEGMENT_SECONDS;
                let duration = (metadata.duration - start).min(LONG_VIDEO_SEGMENT_SECONDS);
                let segment_path = segment_dir.join(format!("part-{:03}.mp4", index + 1));
                update_progress(
                    &app,
                    &task_id,
                    "segmenting",
                    0.12 + 0.32 * index as f64 / segment_count as f64,
                    &format!("本地长视频共 {segment_count} 段，正在准备第 {} 段", index + 1),
                );
                let compression_source = source_path.clone();
                let compression_target = segment_path.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    crate::media_tools::compress_video_segment_for_inline_analysis(
                        &compression_source,
                        &compression_target,
                        start,
                        duration,
                        crate::ai::LINGKE_INLINE_TARGET,
                    )
                })
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        segment_error = Some(error);
                        break;
                    }
                    Err(error) => {
                        segment_error = Some(format!("本地长视频分段任务异常：{error}"));
                        break;
                    }
                }
                let validation_path = segment_path.clone();
                let segment_size = match tauri::async_runtime::spawn_blocking(move || {
                    crate::media_tools::probe_video_metadata(&validation_path)
                })
                .await
                {
                    Ok(Ok(value)) => value.size_bytes,
                    Ok(Err(error)) => {
                        segment_error = Some(error);
                        break;
                    }
                    Err(error) => {
                        segment_error = Some(format!("本地长视频分段校验异常：{error}"));
                        break;
                    }
                };
                update_progress(
                    &app,
                    &task_id,
                    "segment_analyzing",
                    0.44 + 0.48 * index as f64 / segment_count as f64,
                    &format!("正在解析本地长视频第 {} / {} 段", index + 1, segment_count),
                );
                let segment_prompt = long_video_segment_prompt(
                    &input.prompt,
                    index,
                    segment_count,
                    start,
                    duration,
                    metadata.duration,
                );
                let segment_name = format!("{}-第{}段.mp4", original_name, index + 1);
                let analysis = crate::platform_video_understanding::understand_uploaded_file_confirmed(
                    input.platform_api_base_url.as_deref(),
                    &segment_path,
                    &segment_prompt,
                    segment_name,
                    segment_size,
                    &provider_model_id,
                    unit_credits,
                    &format!("{task_id}-{execution_key}-segment-{}-of-{segment_count}", index + 1),
                    Some(crate::platform_video_understanding::VideoUnderstandingBilling {
                        group_id: &execution_key,
                        segment_index: index,
                        segment_count,
                        expected_mode: &billing_mode,
                    }),
                )
                .await;
                let _ = tokio::fs::remove_file(&segment_path).await;
                match analysis {
                    Ok(result) => {
                        segment_results.push(result);
                        segment_durations.push(duration);
                    }
                    Err(error) => {
                        segment_error = Some(error);
                        break;
                    }
                }
            }
            let _ = tokio::fs::remove_dir_all(&segment_dir).await;
            if let Some(error) = segment_error {
                finish_failed(&app, &task_id, error);
                return;
            }
            update_progress(&app, &task_id, "merging", 0.96, "所有视频片段解析完成，正在合并完整分镜、人物和场景");
            match merge_long_video_results(
                &segment_results,
                &segment_durations,
                metadata.duration,
                original_name,
                metadata.size_bytes,
            ) {
                Ok(result) => finish_completed(&app, &task_id, &result),
                Err(error) => finish_failed(&app, &task_id, error),
            }
            return;
        }

        let compressed_path = temp_dir.join(format!("{}-compressed.mp4", uuid::Uuid::new_v4().simple()));
        update_progress(
            &app,
            &task_id,
            "compressing",
            0.18,
            "正在压缩本地视频，准备上传服务端",
        );
        let compression_source = source_path.clone();
        let compression_target = compressed_path.clone();
        let compression = tauri::async_runtime::spawn_blocking(move || {
            crate::media_tools::compress_video_for_inline_analysis(
                &compression_source,
                &compression_target,
                crate::ai::LINGKE_INLINE_TARGET,
            )
        })
        .await;
        match compression {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = tokio::fs::remove_file(&compressed_path).await;
                finish_failed(&app, &task_id, error);
                return;
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&compressed_path).await;
                finish_failed(&app, &task_id, format!("视频压缩任务异常：{error}"));
                return;
            }
        }
        update_progress(
            &app,
            &task_id,
            "analyzing",
            0.48,
            "正在上传压缩视频，服务端 AI 随后会理解视频并生成分镜脚本",
        );
        let analysis = crate::platform_video_understanding::understand_uploaded_file_confirmed(
            input.platform_api_base_url.as_deref(),
            &compressed_path,
            &input.prompt,
            original_name,
            metadata.size_bytes,
            &provider_model_id,
            unit_credits,
            &format!("{task_id}-{execution_key}-detailed"),
            None,
        )
        .await;
        let _ = tokio::fs::remove_file(&compressed_path).await;
        match analysis {
            Ok(result) => finish_completed(&app, &task_id, &result),
            Err(error) => finish_failed(&app, &task_id, error),
        }
    });
}

fn finish_failed(app: &tauri::AppHandle, task_id: &str, error: String) {
    let parsed = serde_json::from_str::<Value>(&error)
        .unwrap_or_else(|_| json!({"message": error, "retryable": true}));
    if let (Ok(connection), Ok(error_json)) = (open(app), serde_json::to_string(&parsed)) {
        let now = Utc::now().to_rfc3339();
        let _ = connection.execute(
            "UPDATE douyin_understanding_tasks SET status = 'FAILED', stage = 'failed',
             message = '任务执行失败', error_json = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1",
            params![task_id, error_json, now],
        );
    }
}

#[tauri::command]
pub fn create_douyin_understanding_task(
    app: tauri::AppHandle,
    mut input: CreateDouyinUnderstandingTaskInput,
) -> Result<Value, String> {
    if input.share_text.trim().is_empty() || input.prompt.trim().len() < 10 {
        return Err("视频链接或视频理解提示词无效".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    if !matches!(input.video_submission_mode.as_str(), "url" | "upload") {
        return Err("视频提交方式无效".to_owned());
    }
    if let Some(duration) = input
        .video_info
        .get("duration")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > LONG_VIDEO_THRESHOLD_SECONDS)
    {
        if !input.long_video_confirmed {
            return Err(format!(
                "该视频时长为 {:.0} 秒，超过 5 分钟。请确认长视频将下载、分段解析并合并后再开始。",
                duration
            ));
        }
        if input.video_submission_mode != "upload" {
            return Err("超过 5 分钟的视频必须使用下载、分段上传解析模式".to_owned());
        }
    }
    if input
        .provider_model_id
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        || input
            .expected_credits
            .is_none_or(|value| !value.is_finite() || value < 0.0)
    {
        return Err("请先确认本次视频理解所需积分".to_owned());
    }
    if !matches!(input.extraction_billing_mode.as_str(), "OVERALL" | "PER_SEGMENT") {
        return Err("提取剧本扣费模式无效，请重新获取报价".to_owned());
    }
    input.fixed_seconds = normalized_fixed_seconds(&input.mode, input.fixed_seconds)?;
    let connection = open(&app)?;
    let id = format!("DYTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    let title = value_text(&input.video_info, "title");
    let uploader = value_text(&input.video_info, "uploader");
    let platform = match value_text(&input.video_info, "platform") {
        value if value.is_empty() => "UNKNOWN".to_owned(),
        value => value,
    };
    let thumbnail = input.video_info.get("thumbnail").and_then(Value::as_str);
    let duration = input.video_info.get("duration").and_then(Value::as_f64);
    let width = input.video_info.get("width").and_then(Value::as_u64);
    let height = input.video_info.get("height").and_then(Value::as_u64);
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, thumbnail, duration, width, height, aspect_ratio,
                mode, fixed_seconds, status, stage, progress, message, input_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'PENDING', 'queued', 0,
                '已加入队列，准备自动识别并解析视频', ?13, ?14, ?14)",
            params![id, input.share_text, title, uploader, platform, thumbnail, duration, width, height,
                input.aspect_ratio, input.mode, input.fixed_seconds, input_json, now],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    spawn_task(app.clone(), id.clone());
    get_task(&app, &id)
}

#[tauri::command]
pub async fn list_douyin_understanding_tasks(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    crate::background::run("读取视频理解任务", move || {
        let connection = open(&app)?;
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_TASK} WHERE source_kind = 'LINK' ORDER BY created_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let tasks = statement
            .query_map([], task_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub async fn list_local_video_understanding_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<Value>, String> {
    crate::background::run("读取本地视频理解任务", move || {
        let connection = open(&app)?;
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_TASK} WHERE source_kind = 'LOCAL' ORDER BY created_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let tasks = statement
            .query_map([], task_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub fn create_local_video_understanding_task(
    app: tauri::AppHandle,
    mut input: CreateLocalVideoUnderstandingTaskInput,
) -> Result<Value, String> {
    let video_path = PathBuf::from(input.video_path.trim());
    if !video_path.is_file() {
        return Err("请选择有效的本地视频文件".to_owned());
    }
    if input.prompt.trim().len() < 10 {
        return Err("视频理解提示词无效".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    input.fixed_seconds = normalized_fixed_seconds(&input.mode, input.fixed_seconds)?;
    let metadata = crate::media_tools::probe_video_metadata(&video_path)?;
    input.prompt = if let Some(seconds) = input.fixed_seconds {
        let shot_count = (metadata.duration / seconds as f64).ceil() as u64;
        format!(
            "{}\n\n【本地视频真实时长与固定分镜规则（最高优先级）】\nFFprobe 已确认本视频完整时长为 {:.3} 秒，画面尺寸为 {}×{}。必须从 0 秒开始分析并连续覆盖真实结尾；必须生成 {} 个分镜，最后一段标题结束于原视频真实结尾。每段标题下一行必须输出“生成时长：{}秒”，且每个分镜（包括最后一个）的生成时长都恰好为 {} 秒。最后一个分镜不足的部分只保持最后一个有意义的画面状态，不得新增剧情、台词、人物或动作。输出前必须核对全部分镜时长。",
            input.prompt.trim(),
            metadata.duration,
            metadata.width,
            metadata.height,
            shot_count,
            seconds,
            seconds,
        )
    } else {
        format!(
            "{}\n\n【本地视频真实时长（最高优先级）】\nFFprobe 已确认本视频完整时长为 {:.3} 秒，画面尺寸为 {}×{}。必须从 0 秒开始分析并连续覆盖到 {:.3} 秒的真实结尾；最后一个分镜的结束时间必须等于 {:.3} 秒（仅允许 0.5 秒以内的取整误差）。不得在 40 秒或任何中间位置提前结束，不得遗漏后半段内容，也不得虚构超出视频结尾的内容。输出前必须核对分镜时间轴总时长。",
            input.prompt.trim(),
            metadata.duration,
            metadata.width,
            metadata.height,
            metadata.duration,
            metadata.duration,
        )
    };
    let title = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("本地视频")
        .to_owned();
    let connection = open(&app)?;
    let id = format!("VIDTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, duration, width, height, aspect_ratio,
                mode, fixed_seconds, status, stage, progress, message, input_json, created_at,
                updated_at, source_kind
             ) VALUES (?1, ?2, ?3, '本地文件', 'UNKNOWN', ?4, ?5, ?6, ?7, ?8, ?9,
                'PENDING', 'queued', 0, ?10, ?11, ?12, ?12, 'LOCAL')",
            params![
                id,
                video_path.to_string_lossy(),
                title,
                metadata.duration,
                metadata.width,
                metadata.height,
                metadata.aspect_ratio,
                input.mode,
                input.fixed_seconds,
                format!(
                    "已读取完整视频：{:.1}秒，已加入后台理解队列",
                    metadata.duration
                ),
                input_json,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    spawn_local_task(app.clone(), id.clone());
    get_task(&app, &id)
}

#[tauri::command]
pub fn save_local_video_understanding_task(
    app: tauri::AppHandle,
    input: SaveLocalVideoUnderstandingTaskInput,
) -> Result<Value, String> {
    if input.video_path.trim().is_empty() {
        return Err("本地视频路径不能为空".to_owned());
    }
    if !matches!(input.mode.as_str(), "standard" | "detailed" | "fixed") {
        return Err("视频理解模式无效".to_owned());
    }
    if input
        .result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .len()
        < 10
    {
        return Err("本地视频理解结果为空".to_owned());
    }
    if input
        .aspect_ratio
        .as_deref()
        .is_some_and(|value| !matches!(value, "9:16" | "16:9"))
    {
        return Err("视频画面比例必须是9:16或16:9".to_owned());
    }
    let path = PathBuf::from(input.video_path.trim());
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("本地视频")
        .to_owned();
    let connection = open(&app)?;
    let id = format!("VIDTASK_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let input_json = serde_json::to_string(&json!({
        "video_path": input.video_path,
        "mode": input.mode,
        "fixed_seconds": input.fixed_seconds,
        "duration": input.duration,
        "aspect_ratio": input.aspect_ratio,
    }))
    .map_err(|error| error.to_string())?;
    let result_json = serde_json::to_string(&input.result).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO douyin_understanding_tasks (
                id, share_text, title, uploader, platform, duration, aspect_ratio, mode, fixed_seconds,
                status, stage, progress, message, input_json, result_json, created_at, updated_at,
                finished_at, source_kind
             ) VALUES (?1, ?2, ?3, '本地文件', 'UNKNOWN', ?4, ?5, ?6, ?7,
                'COMPLETED', 'completed', 1, '视频理解与分镜生成完成', ?8, ?9, ?10, ?10, ?10, 'LOCAL')",
            params![
                id,
                path.to_string_lossy(),
                title,
                input.duration,
                input.aspect_ratio,
                input.mode,
                input.fixed_seconds,
                input_json,
                result_json,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get_task(&app, &id)
}

#[tauri::command]
pub fn retry_douyin_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Value, String> {
    let connection = open(&app)?;
    let changed = connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入队列', error_json = NULL, finished_at = NULL, updated_at = ?2
             WHERE id = ?1 AND source_kind = 'LINK' AND status = 'FAILED'",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有失败的任务可以重试".to_owned());
    }
    drop(connection);
    spawn_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn reparse_douyin_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
    provider_model_id: String,
    expected_credits: f64,
    extraction_billing_mode: String,
    platform_api_base_url: Option<String>,
) -> Result<Value, String> {
    if provider_model_id.trim().is_empty()
        || !expected_credits.is_finite()
        || expected_credits < 0.0
    {
        return Err("请先确认本次视频理解所需积分".to_owned());
    }
    if !matches!(extraction_billing_mode.as_str(), "OVERALL" | "PER_SEGMENT") {
        return Err("提取剧本扣费模式无效，请重新获取报价".to_owned());
    }
    let connection = open(&app)?;
    let input_json = connection
        .query_row(
            "SELECT input_json FROM douyin_understanding_tasks
             WHERE id = ?1 AND source_kind = 'LINK' AND status = 'COMPLETED'",
            [&task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "只有已完成的视频链接任务可以重新解析".to_owned())?;
    let mut input = serde_json::from_str::<CreateDouyinUnderstandingTaskInput>(&input_json)
        .map_err(|error| format!("视频链接任务参数损坏：{error}"))?;

    // Resolved media URLs are short-lived. A reparse must start from the
    // original share text and obtain fresh metadata and a fresh download URL.
    input.video_info = json!({});
    input.source_width = None;
    input.source_height = None;
    input.aspect_ratio = None;
    input.video_submission_mode = "upload".to_owned();
    input.provider_model_id = Some(provider_model_id.trim().to_owned());
    input.expected_credits = Some(expected_credits);
    input.extraction_billing_mode = extraction_billing_mode;
    input.platform_api_base_url = platform_api_base_url;
    let refreshed_input_json = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    let changed = connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入视频解析队列，正在重新获取视频地址', input_json = ?3,
             error_json = NULL, finished_at = NULL, updated_at = ?2
             WHERE id = ?1 AND source_kind = 'LINK' AND status = 'COMPLETED'",
            params![task_id, Utc::now().to_rfc3339(), refreshed_input_json],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有已完成的视频链接任务可以重新解析".to_owned());
    }
    drop(connection);
    spawn_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn retry_local_video_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Value, String> {
    let connection = open(&app)?;
    let changed = connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '已重新加入本地视频理解队列', error_json = NULL, finished_at = NULL,
             updated_at = ?2 WHERE id = ?1 AND source_kind = 'LOCAL' AND status = 'FAILED'",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("只有失败的本地视频理解任务可以重试".to_owned());
    }
    drop(connection);
    spawn_local_task(app.clone(), task_id.clone());
    get_task(&app, &task_id)
}

#[tauri::command]
pub fn delete_video_understanding_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let mut connection = open(&app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM video_remix_tasks WHERE source_task_id = ?1",
            [&task_id],
        )
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "DELETE FROM douyin_understanding_tasks WHERE id = ?1",
            [&task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("视频解析或理解记录不存在".to_owned());
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let connection = open(app)?;
    connection
        .execute(
            "UPDATE douyin_understanding_tasks SET status = 'PENDING', stage = 'queued', progress = 0,
             message = '应用已恢复任务，等待重新执行', updated_at = ?1
             WHERE status = 'RUNNING'",
            [Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, source_kind FROM douyin_understanding_tasks WHERE status = 'PENDING'")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);
    for (id, source_kind) in ids {
        if source_kind == "LOCAL" {
            spawn_local_task(app.clone(), id);
        } else {
            spawn_task(app.clone(), id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        long_video_segment_count, merge_long_video_results, normalized_fixed_seconds,
        offset_shot_titles, video_duration_is_complete,
    };
    use crate::ai::VideoUnderstandingResult;

    #[test]
    fn fixed_mode_defaults_to_ten_and_rejects_unsupported_durations() {
        assert_eq!(normalized_fixed_seconds("fixed", None).unwrap(), Some(10));
        assert_eq!(normalized_fixed_seconds("fixed", Some(6)).unwrap(), Some(6));
        assert!(normalized_fixed_seconds("fixed", Some(9)).is_err());
        assert_eq!(
            normalized_fixed_seconds("standard", Some(10)).unwrap(),
            None
        );
    }

    #[test]
    fn splits_only_videos_longer_than_five_minutes() {
        assert_eq!(long_video_segment_count(300.0), 1);
        assert_eq!(long_video_segment_count(300.1), 2);
        assert_eq!(long_video_segment_count(11.0 * 60.0 + 43.0), 3);
    }

    #[test]
    fn rejects_truncated_downloads_using_the_resolved_duration() {
        assert!(video_duration_is_complete(703.0, Some(703.448)));
        assert!(!video_duration_is_complete(360.0, Some(703.448)));
        assert!(video_duration_is_complete(12.0, None));
    }

    #[test]
    fn offsets_local_segment_titles_onto_the_full_video_timeline() {
        let mut next = 31;
        let output = offset_shot_titles(
            "第1段（0～10秒）\n画面：测试\n\n第2段（10～15.5秒）",
            300.0,
            &mut next,
        );
        assert!(output.contains("第31段（300～310秒）"));
        assert!(output.contains("第32段（310～315.5秒）"));
        assert_eq!(next, 33);
    }

    #[test]
    fn merges_segment_catalogs_and_shots_without_duplicate_named_characters() {
        let first = VideoUnderstandingResult {
            text: "一、项目剧情\n标题：测试\n故事概要：第一段事件\n\n二、全局角色库\n【角色 CHAR_001】\n名称：讲述者\n外貌锁定：测试\n\n三、全局场景库\n【场景 SCENE_001】\n名称：室内\n场景锁定：测试\n\n四、分镜列表\n第1段（0～10秒）\n人物引用：CHAR_001｜讲述者\n场景引用：SCENE_001｜室内\n画面：测试"
                .to_owned(),
            model: "test-model".to_owned(),
            upload_mode: "server-upload".to_owned(),
            video_name: "part-1.mp4".to_owned(),
            size_bytes: 1,
        };
        let second = VideoUnderstandingResult {
            text: "一、项目剧情\n标题：测试\n故事概要：第二段事件\n\n二、全局角色库\n【角色 CHAR_001】\n名称：讲述者\n外貌锁定：测试\n\n三、全局场景库\n【场景 SCENE_001】\n名称：室外\n场景锁定：测试\n\n四、分镜列表\n第1段（0～10秒）\n人物引用：CHAR_001｜讲述者\n场景引用：SCENE_001｜室外\n画面：测试"
                .to_owned(),
            model: "test-model".to_owned(),
            upload_mode: "server-upload".to_owned(),
            video_name: "part-2.mp4".to_owned(),
            size_bytes: 1,
        };
        let merged = merge_long_video_results(
            &[first, second],
            &[300.0, 103.0],
            403.0,
            "full.mp4".to_owned(),
            2,
        )
        .unwrap();
        assert_eq!(merged.text.matches("【角色 CHAR_001】").count(), 1);
        assert!(merged.text.contains("【场景 SCENE_002】"));
        assert!(merged.text.contains("第2段（300～310秒）"));
        assert!(merged.text.contains("第一段事件"));
        assert!(merged.text.contains("第二段事件"));
        assert_eq!(merged.upload_mode, "server-upload-segmented");
    }
}
