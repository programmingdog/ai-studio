use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{agent_store, ai, commands, project::manager::CreateProjectInput};

const AGENT_SYSTEM_PROMPT: &str = r#"你是 AI Video Studio 的制作智能体。你的任务是通过对话帮助用户完成抖音、快手或哔哩哔哩视频链接解析、视频下载与理解、结构化分镜项目创建，以及后续图片和视频自动制作。

规则：
1. 只有当用户明确要求开始执行时才调用工具；仅咨询方案时不要启动耗时或计费任务。
2. 用户提供视频分享文案或链接并要求生成项目/完成制作时，调用 create_douyin_project。
3. 默认项目目录是 C:\AI Video Studio Projects，默认分析模式 standard，默认制作模式 fast，默认视频分辨率 720p。用户明确指定时覆盖默认值。
4. standard 使用系统中配置的默认视频理解提示词；detailed 使用详细提示词；fixed 使用固定秒数规则（仅 6、10、15 秒，默认 10 秒）。视频理解模型由系统单独配置，不能改用 Agent 模型。
5. fast 表示不生成分镜图，场景图与角色图完成后直接生成视频；storyboard 表示先生成分镜图并作为视频参考图。
6. 工具执行成功后，简洁说明已创建项目和下一步自动制作状态。执行失败时准确说明错误并给出可操作的重试建议。
7. 不要编造任务状态、文件路径或生成结果。"#;

#[derive(Debug, Deserialize)]
pub struct AgentSendInput {
    session_id: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct AgentSendResult {
    session: agent_store::AgentSession,
    message: agent_store::AgentMessage,
    run: agent_store::AgentRun,
    action: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CreateDouyinProjectArgs {
    share_text: String,
    #[serde(default = "default_project_root")]
    project_root: String,
    #[serde(default = "default_analysis_mode")]
    analysis_mode: String,
    fixed_seconds: Option<u64>,
    #[serde(default = "default_production_mode")]
    production_mode: String,
    #[serde(default = "default_resolution")]
    resolution: String,
}

fn default_project_root() -> String {
    r"C:\AI Video Studio Projects".to_owned()
}
fn default_analysis_mode() -> String {
    "standard".to_owned()
}
fn default_production_mode() -> String {
    "fast".to_owned()
}
fn default_resolution() -> String {
    "720p".to_owned()
}

#[tauri::command]
pub async fn list_agent_sessions(
    app: tauri::AppHandle,
) -> Result<Vec<agent_store::AgentSession>, String> {
    crate::background::run("读取 Agent 会话", move || {
        agent_store::list_sessions(&app)
    })
    .await
}

#[tauri::command]
pub async fn list_agent_messages(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<agent_store::AgentMessage>, String> {
    crate::background::run("读取 Agent 消息", move || {
        agent_store::list_messages(&app, session_id.trim())
    })
    .await
}

#[tauri::command]
pub async fn list_agent_runs(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<agent_store::AgentRun>, String> {
    crate::background::run("读取 Agent 任务", move || {
        agent_store::list_runs(&app, session_id.trim())
    })
    .await
}

#[tauri::command]
pub async fn send_agent_message(
    app: tauri::AppHandle,
    input: AgentSendInput,
) -> Result<AgentSendResult, String> {
    let text = input.message.trim();
    if text.is_empty() || text.chars().count() > 20_000 {
        return Err(agent_error(
            "AGENT_MESSAGE_INVALID",
            "消息不能为空且不能超过 20000 个字符",
            false,
        ));
    }
    let session = agent_store::ensure_session(&app, input.session_id.as_deref(), text)?;
    agent_store::append_message(&app, &session.id, "user", text, &json!({}))?;
    let config = ai::load_agent_config(&app)?;
    let mut run = agent_store::create_run(
        &app,
        &session.id,
        &config.agent_model,
        &json!({"message": text}),
    )?;
    let result = run_agent_loop(&app, &session.id, &run.id, &config).await;
    match result {
        Ok((content, action)) => {
            let metadata = action
                .as_ref()
                .map(|value| json!({"action": value}))
                .unwrap_or_else(|| json!({}));
            let message =
                agent_store::append_message(&app, &session.id, "assistant", &content, &metadata)?;
            run = agent_store::update_run(
                &app,
                &run.id,
                "COMPLETED",
                "completed",
                1.0,
                &json!({"action": action}),
                None,
            )?;
            let sessions = agent_store::list_sessions(&app)?;
            let session = sessions
                .into_iter()
                .find(|item| item.id == session.id)
                .unwrap_or(session);
            Ok(AgentSendResult {
                session,
                message,
                run,
                action,
            })
        }
        Err(message) => {
            let error_value = parse_error_value(&message);
            let _ = agent_store::update_run(
                &app,
                &run.id,
                "FAILED",
                "failed",
                run.progress,
                &json!({}),
                Some(&error_value),
            );
            Err(message)
        }
    }
}

async fn run_agent_loop(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    config: &ai::AgentAiConfig,
) -> Result<(String, Option<Value>), String> {
    let history = agent_store::list_messages(app, session_id)?;
    let mut messages = vec![json!({"role": "system", "content": AGENT_SYSTEM_PROMPT})];
    messages.extend(
        history
            .into_iter()
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|item| json!({"role": item.role, "content": item.content})),
    );
    let mut action = None;

    for _ in 0..8 {
        let payload = crate::platform_media::text_completion("Agent 文本规划（每轮调用分别计费）", json!({
            "messages": messages,
            "tools": agent_tools(),
            "tool_choice": "auto",
            "temperature": 0.2,
            "stream": false
        })).await?;
        let message = payload
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| {
                agent_error(
                    "AGENT_RESPONSE_INVALID",
                    "Agent 接口未返回 choices[0].message",
                    true,
                )
            })?;
        let calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if calls.is_empty() {
            let content = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("任务处理完成。")
                .trim()
                .to_owned();
            return Ok((content, action));
        }
        messages.push(message.clone());
        for call in calls {
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("tool_call")
                .to_owned();
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let arguments_text = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let arguments: Value = serde_json::from_str(arguments_text).map_err(|error| {
                agent_error(
                    "AGENT_TOOL_ARGUMENTS_INVALID",
                    format!("工具 {name} 参数不是有效 JSON：{error}"),
                    false,
                )
            })?;
            let tool_call_id = agent_store::start_tool_call(app, run_id, name, &arguments)?;
            let result = execute_tool(app, session_id, run_id, name, arguments, config).await;
            match result {
                Ok(value) => {
                    agent_store::finish_tool_call(app, &tool_call_id, Ok(&value))?;
                    if let Some(value_action) = value.get("client_action") {
                        action = Some(value_action.clone());
                        let project_name = value
                            .get("project_name")
                            .and_then(Value::as_str)
                            .unwrap_or("新项目");
                        let production = value_action.get("type").and_then(Value::as_str)
                            == Some("open_project_and_start_production");
                        let content = if production {
                            format!("项目“{project_name}”已创建，视频由 {} 完成理解和分镜解析。现在将打开项目并启动自动制作工作流。", config.video_model)
                        } else {
                            format!("项目“{project_name}”已创建，视频由 {} 完成理解和分镜解析。现在将打开项目供你查看编辑。", config.video_model)
                        };
                        return Ok((content, action));
                    }
                    messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": value.to_string()}));
                }
                Err(message) => {
                    let error_value = parse_error_value(&message);
                    agent_store::finish_tool_call(app, &tool_call_id, Err(&error_value))?;
                    messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": json!({"ok": false, "error": error_value}).to_string()}));
                }
            }
        }
    }
    Err(agent_error(
        "AGENT_MAX_STEPS",
        "Agent 连续工具调用次数过多，请缩小任务范围后重试",
        true,
    ))
}

fn agent_tools() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "create_douyin_project",
            "description": "自动识别并解析抖音、快手或哔哩哔哩视频分享链接，下载后用独立配置的 Gemini 视频理解模型生成分镜脚本，然后创建可编辑项目；可继续触发完整图片和视频自动制作。",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "share_text": {"type": "string", "description": "完整视频分享文案或链接"},
                    "project_root": {"type": "string", "description": "项目保存根目录，默认 C:\\AI Video Studio Projects"},
                    "analysis_mode": {"type": "string", "enum": ["standard", "detailed", "fixed"]},
                    "fixed_seconds": {"type": "integer", "enum": [6, 10, 15]},
                    "production_mode": {"type": "string", "enum": ["none", "fast", "storyboard"]},
                    "resolution": {"type": "string", "enum": ["default", "480p", "720p", "768P", "1080p", "2K", "4K"]}
                },
                "required": ["share_text", "project_root", "analysis_mode", "production_mode", "resolution"]
            }
        }
    }])
}

async fn execute_tool(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    name: &str,
    arguments: Value,
    config: &ai::AgentAiConfig,
) -> Result<Value, String> {
    match name {
        "create_douyin_project" => {
            let args: CreateDouyinProjectArgs =
                serde_json::from_value(arguments).map_err(|error| {
                    agent_error(
                        "AGENT_TOOL_ARGUMENTS_INVALID",
                        format!("创建链接视频项目参数无效：{error}"),
                        false,
                    )
                })?;
            create_douyin_project(app, session_id, run_id, args, config).await
        }
        _ => Err(agent_error(
            "AGENT_TOOL_UNKNOWN",
            format!("不支持的 Agent 工具：{name}"),
            false,
        )),
    }
}

async fn create_douyin_project(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    mut args: CreateDouyinProjectArgs,
    config: &ai::AgentAiConfig,
) -> Result<Value, String> {
    if args.share_text.trim().is_empty() {
        return Err(agent_error(
            "DOUYIN_URL_REQUIRED",
            "请提供视频分享文案或链接",
            false,
        ));
    }
    if !matches!(
        args.analysis_mode.as_str(),
        "standard" | "detailed" | "fixed"
    ) {
        args.analysis_mode = "standard".into();
    }
    if !matches!(
        args.production_mode.as_str(),
        "none" | "fast" | "storyboard"
    ) {
        args.production_mode = "fast".into();
    }
    if args.project_root.trim().is_empty() {
        args.project_root = default_project_root();
    }
    agent_store::update_run(
        app,
        run_id,
        "RUNNING",
        "douyin_resolve",
        0.12,
        &json!({"message": "正在解析视频链接"}),
        None,
    )?;
    let resolved = commands::resolve_douyin_auto(app.clone(), args.share_text.clone()).await?;
    let width = resolved.get("width").and_then(Value::as_u64);
    let height = resolved.get("height").and_then(Value::as_u64);
    let aspect_ratio = match (width, height) {
        (Some(width), Some(height)) if width > height => "16:9",
        _ => "9:16",
    };
    let prompt = match args.analysis_mode.as_str() {
        "detailed" => format!("{}\n\n【分镜时长硬性规则】每个分镜必须小于或等于15秒，优先按10秒整数边界切分；输出前逐段校验，超过15秒必须拆分。\n\n【分镜内部局部时间轴硬性规则】分镜标题保留原视频全局时间；每个分镜的“画面”子时间段必须独立从0秒开始，最后结束于该分镜自身时长。后续分镜不得在画面或生成提示词中沿用原片全局秒数。", config.video_storyboard_detailed_prompt),
        "fixed" => {
            let seconds = match args.fixed_seconds.unwrap_or(10) { 6 => 6, 15 => 15, _ => 10 };
            format!("{}\n\n【固定分镜时长规则（最高优先级）】除最后一段外，每段必须严格为{seconds}秒，从0秒开始连续切分；最后一段按真实剩余时长输出，时间轴不得重叠、遗漏或虚构内容。", config.video_storyboard_prompt)
        }
        _ => config.video_storyboard_prompt.clone(),
    };
    agent_store::update_run(
        app,
        run_id,
        "RUNNING",
        "video_understanding",
        0.28,
        &json!({
            "message": "正在下载视频并生成结构化分镜", "video_model": config.video_model,
            "analysis_mode": args.analysis_mode, "aspect_ratio": aspect_ratio
        }),
        None,
    )?;
    let analyzed = commands::analyze_douyin_video(
        app.clone(),
        commands::DouyinStoryboardInput {
            share_text: args.share_text.clone(),
            prompt,
            source_width: width,
            source_height: height,
            aspect_ratio: Some(aspect_ratio.into()),
            managed: true,
            browser_cookie_source: None,
            cookie_file_path: None,
        },
    )
    .await?;
    let storyboard = analyzed.text;
    let fallback_title = resolved
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("链接视频项目");
    let title =
        storyboard_title(&storyboard).unwrap_or_else(|| fallback_title.chars().take(60).collect());
    let duration = resolved
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(60.0)
        .round()
        .clamp(5.0, 3600.0) as u64;
    let creation_spec = json!({
        "project_name": title,
        "input_type": "SCRIPT",
        "target_duration": duration,
        "aspect_ratio": aspect_ratio,
        "content_type": "SHORT_DRAMA",
        "visual_style": "使用视频理解提取的画风",
        "target_platform": resolved.get("platform").and_then(Value::as_str).unwrap_or("VIDEO_PLATFORM"),
        "language": "zh-CN",
        "creation_mode": "DIRECTOR"
    });
    agent_store::update_run(
        app,
        run_id,
        "RUNNING",
        "project_create",
        0.68,
        &json!({"message": "正在创建项目并导入分镜脚本", "title": title}),
        None,
    )?;
    let app_for_create = app.clone();
    let root_path = args.project_root.clone();
    let storyboard_for_create = storyboard.clone();
    let spec_for_create = creation_spec.clone();
    let bundle = tauri::async_runtime::spawn_blocking(move || {
        let bundle = crate::project::manager::create(CreateProjectInput {
            root_path,
            source_type: "SCRIPT_TEXT".into(),
            source_text: Some(storyboard_for_create.clone()),
            source_path: None,
            creation_spec: spec_for_create.clone(),
        })?;
        crate::project::registry::register(&app_for_create, &bundle, false)?;
        let project_path = bundle
            .pointer("/project/project_path")
            .and_then(Value::as_str)
            .ok_or("新项目缺少 project_path")?
            .to_owned();
        let project_id = bundle
            .pointer("/project/id")
            .and_then(Value::as_str)
            .ok_or("新项目缺少 id")?
            .to_owned();
        commands::analyze_script(
            project_path,
            project_id,
            storyboard_for_create,
            None,
            spec_for_create,
        )
    })
    .await
    .map_err(|error| {
        agent_error(
            "AGENT_PROJECT_TASK_ERROR",
            format!("项目创建后台任务异常：{error}"),
            true,
        )
    })??;
    let project_id = bundle
        .pointer("/project/id")
        .and_then(Value::as_str)
        .ok_or("创建结果缺少项目编号")?
        .to_owned();
    let project_path = bundle
        .pointer("/project/project_path")
        .and_then(Value::as_str)
        .ok_or("创建结果缺少项目目录")?
        .to_owned();
    agent_store::attach_project(app, session_id, &project_id, &project_path)?;
    let production = args.production_mode != "none";
    let client_action = json!({
        "type": if production { "open_project_and_start_production" } else { "open_project" },
        "project_id": project_id,
        "project_path": project_path,
        "production_mode": args.production_mode,
        "resolution": args.resolution
    });
    agent_store::update_run(
        app,
        run_id,
        "RUNNING",
        "project_ready",
        0.9,
        &json!({
            "message": if production { "项目已创建，正在转交自动制作工作流" } else { "项目已创建" },
            "client_action": client_action
        }),
        None,
    )?;
    Ok(json!({
        "ok": true,
        "project_id": project_id,
        "project_path": project_path,
        "project_name": title,
        "storyboard_characters": storyboard.chars().count(),
        "video_understanding_model": config.video_model,
        "client_action": client_action
    }))
}

fn storyboard_title(storyboard: &str) -> Option<String> {
    for line in storyboard.lines() {
        let trimmed = line
            .trim()
            .trim_matches(|character| matches!(character, '*' | '#' | '-' | '【' | '】'));
        for prefix in ["主题：", "主题:", "标题：", "标题:"] {
            if let Some(value) = trimmed.strip_prefix(prefix) {
                let value = value
                    .trim()
                    .trim_matches(|character| matches!(character, '*' | '【' | '】'));
                if !value.is_empty() {
                    return Some(value.chars().take(60).collect());
                }
            }
        }
    }
    None
}

fn parse_error_value(message: &str) -> Value {
    serde_json::from_str(message).unwrap_or_else(|_| json!({"message": message, "retryable": true}))
}

fn agent_error(code: &str, message: impl Into<String>, retryable: bool) -> String {
    json!({"code": code, "message": message.into(), "retryable": retryable}).to_string()
}

fn agent_http_error(status: StatusCode, endpoint: &str, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.chars().take(800).collect());
    agent_error(
        "AGENT_API_ERROR",
        format!(
            "Agent 接口请求失败（{}）：{}；接口：{}",
            status.as_u16(),
            detail,
            endpoint
        ),
        status.is_server_error()
            || matches!(
                status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::REQUEST_TIMEOUT
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_storyboard_theme_or_title() {
        assert_eq!(
            storyboard_title("【项目剧情】\n主题：黑夜告白\n"),
            Some("黑夜告白".into())
        );
        assert_eq!(storyboard_title("标题: 重逢\n"), Some("重逢".into()));
    }

    #[test]
    fn tool_schema_keeps_video_model_out_of_agent_arguments() {
        let tools = agent_tools();
        assert!(tools[0]["function"]["parameters"]["properties"]
            .get("video_model")
            .is_none());
    }
}
