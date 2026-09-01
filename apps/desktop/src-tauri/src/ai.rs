use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use keyring::Entry;
use reqwest::{header::HeaderMap, multipart, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    error::Error as StdError,
    fs::{self, OpenOptions},
    io::Write as StdWrite,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

const CREDENTIAL_SERVICE: &str = "studio.aivideo.desktop";
const CREDENTIAL_USER: &str = "unified-ai-api-key";
const DEFAULT_VIDEO_STORYBOARD_PROMPT: &str =
    include_str!("../../src/prompts/video-storyboard-default.txt");
const DEFAULT_VIDEO_STORYBOARD_DETAILED_PROMPT: &str =
    include_str!("../../src/prompts/video-storyboard-detailed.txt");
const DEFAULT_CHARACTER_IMAGE_PROMPT: &str =
    include_str!("../../src/prompts/character-image-default.txt");
// Base64 expands the request by roughly 4/3. Keeping raw media below 70 MiB
// stays under the documented 100 MB inline-data ceiling with room for prompts.
pub(crate) const INLINE_VIDEO_LIMIT: u64 = 70 * 1024 * 1024;
// Lingke currently proxies generateContent but not Gemini's Files API. Keeping
// raw media under 14 MiB leaves room for base64 expansion inside a 20 MB body.
pub(crate) const LINGKE_INLINE_TARGET: u64 = 14 * 1024 * 1024;
const MAX_VIDEO_SIZE: u64 = 2 * 1024 * 1024 * 1024;
const TEXT_AI_MAX_RETRIES: usize = 3;
const TEXT_AI_MAX_ATTEMPTS: usize = TEXT_AI_MAX_RETRIES + 1;
const TEXT_AI_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TEXT_AI_REQUEST_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const VIDEO_DIALOGUE_VISUAL_RULE: &str = "【台词内化到画面的最高优先级规则】每个分镜除在“口播台词”或“台词”字段保留完整台词外，还必须把该分镜内每一位说话人的台词原文直接写入同一分镜的“画面”描述，并明确说话人，例如“角色A说：‘XXXXX’”或“角色A说（具体语气）：‘XXXXX’”。详细模式必须写入台词实际发生的对应局部时间段；标准或固定时长模式写入该分镜画面描述。无台词分镜不添加。";

pub(crate) fn video_understanding_prompt(prompt: &str) -> String {
    format!("{}\n\n{}", prompt.trim(), VIDEO_DIALOGUE_VISUAL_RULE)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AiSettingsFile {
    base_url: String,
    agent_model: String,
    video_model: String,
    video_storyboard_prompt: String,
    video_storyboard_detailed_prompt: String,
    character_image_prompt: String,
    prompt_overrides: Option<PromptOverrideSettings>,
    image_model: String,
    image_protocol: String,
    video_generation_model: String,
    video_generation_protocol: String,
    #[serde(default)]
    credit_costs: CreditCostSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PromptOverrideSettings {
    video_storyboard_prompt: bool,
    video_storyboard_detailed_prompt: bool,
    character_image_prompt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CreditCostSettings {
    image_per_item: f64,
    video_per_second: std::collections::HashMap<String, f64>,
}

impl Default for CreditCostSettings {
    fn default() -> Self {
        Self {
            image_per_item: 1.0,
            video_per_second: [
                ("default", 2.0),
                ("480p", 1.0),
                ("720p", 2.0),
                ("768P", 2.0),
                ("1080p", 3.0),
                ("2K", 5.0),
                ("4K", 8.0),
            ]
            .into_iter()
            .map(|(resolution, cost)| (resolution.to_owned(), cost))
            .collect(),
        }
    }
}

impl Default for AiSettingsFile {
    fn default() -> Self {
        Self {
            base_url: "https://api.lk888.ai".into(),
            agent_model: "gpt-5.6-sol".into(),
            video_model: "gemini-3.7-flash".into(),
            video_storyboard_prompt: DEFAULT_VIDEO_STORYBOARD_PROMPT.trim().into(),
            video_storyboard_detailed_prompt: DEFAULT_VIDEO_STORYBOARD_DETAILED_PROMPT
                .trim()
                .into(),
            character_image_prompt: DEFAULT_CHARACTER_IMAGE_PROMPT.trim().into(),
            prompt_overrides: Some(PromptOverrideSettings::default()),
            image_model: "gpt-image-2".into(),
            image_protocol: "openai".into(),
            video_generation_model: "hailuo-h3-cankaosheng".into(),
            video_generation_protocol: "media".into(),
            credit_costs: CreditCostSettings::default(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AiSettingsView {
    base_url: String,
    agent_model: String,
    video_model: String,
    video_storyboard_prompt: String,
    video_storyboard_detailed_prompt: String,
    character_image_prompt: String,
    prompt_overrides: PromptOverrideSettings,
    image_model: String,
    image_protocol: String,
    video_generation_model: String,
    video_generation_protocol: String,
    credit_costs: CreditCostSettings,
    model_catalog: Vec<crate::database::model_catalog::AiModelCatalogItem>,
    has_api_key: bool,
    api_key_mask: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveAiSettingsInput {
    base_url: String,
    agent_model: String,
    video_model: String,
    video_storyboard_prompt: String,
    video_storyboard_detailed_prompt: String,
    character_image_prompt: String,
    #[serde(default)]
    prompt_overrides: PromptOverrideSettings,
    image_model: String,
    image_protocol: String,
    video_generation_model: String,
    video_generation_protocol: String,
    #[serde(default)]
    credit_costs: CreditCostSettings,
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

#[derive(Debug, Deserialize)]
pub struct VideoUnderstandingInput {
    pub(crate) video_path: String,
    pub(crate) prompt: String,
}

#[derive(Debug, Serialize)]
pub struct VideoUnderstandingResult {
    pub(crate) text: String,
    pub(crate) model: String,
    pub(crate) upload_mode: String,
    pub(crate) video_name: String,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct GenerateProjectImageInput {
    project_path: String,
    target_type: String,
    target_id: String,
    prompt: String,
    aspect_ratio: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateImageGenerationTasksInput {
    workflow_credit_id: Option<String>,
    project_path: String,
    project_id: String,
    platform_api_base_url: String,
    provider_model_id: String,
    model_alias: String,
    resolution: String,
    tasks: Vec<CreateImageGenerationTaskItem>,
}

#[derive(Debug, Deserialize)]
pub struct CreateImageGenerationTaskItem {
    target_type: String,
    target_id: String,
    prompt: String,
    aspect_ratio: String,
    #[serde(default)]
    reference_assets: Vec<GenerationReferenceAssetInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationReferenceAssetInput {
    relative_path: String,
    label: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateShotVideoGenerationInput {
    workflow_credit_id: Option<String>,
    project_path: String,
    project_id: String,
    shot_id: String,
    prompt: String,
    aspect_ratio: String,
    duration: f64,
    resolution: Option<String>,
    version: Option<String>,
    #[serde(default)]
    reference_assets: Vec<GenerationReferenceAssetInput>,
    first_frame_relative_path: Option<String>,
    platform_api_base_url: String,
    provider_model_id: String,
    model_alias: String,
}

#[derive(Debug, Deserialize)]
pub struct ComposeProjectVideoInput {
    project_path: String,
    project_id: String,
    ordered_shot_ids: Vec<String>,
    aspect_ratio: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratedProjectImage {
    relative_path: String,
    absolute_path: String,
    model: String,
    protocol: String,
    prompt: String,
    preview_data_url: String,
}

struct ImageBytes {
    bytes: Vec<u8>,
    mime_type: String,
}

struct ReferenceImage {
    label: String,
    kind: String,
    filename: String,
    bytes: Vec<u8>,
    mime_type: String,
    data_url: String,
}

fn reference_log_detail(reference: &ReferenceImage) -> Value {
    json!({
        "label": reference.label,
        "kind": reference.kind,
        "filename": reference.filename,
        "mime_type": reference.mime_type,
        "bytes": reference.bytes.len(),
        "value": format!("[BINARY/BASE64 REDACTED: {} bytes]", reference.bytes.len()),
    })
}

fn reference_log_details(references: &[ReferenceImage]) -> Vec<Value> {
    references.iter().map(reference_log_detail).collect()
}

enum MediaCreateResult {
    Image(ImageBytes),
    Task(String),
}

static ACTIVE_IMAGE_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static IMAGE_TASK_LIMITER: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static ACTIVE_VIDEO_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static VIDEO_TASK_LIMITER: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static TEXT_AI_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

fn active_image_tasks() -> &'static Mutex<HashSet<String>> {
    ACTIVE_IMAGE_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn unsaved_image_failures() -> &'static Mutex<HashMap<String, String>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn image_task_limiter() -> Arc<tokio::sync::Semaphore> {
    IMAGE_TASK_LIMITER
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
}

fn active_video_tasks() -> &'static Mutex<HashSet<String>> {
    ACTIVE_VIDEO_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn text_ai_client() -> Result<Client, String> {
    TEXT_AI_CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(TEXT_AI_CONNECT_TIMEOUT)
                .timeout(TEXT_AI_REQUEST_TIMEOUT)
                .http1_only()
                .tcp_keepalive(Some(Duration::from_secs(60)))
                .pool_idle_timeout(Duration::from_secs(30))
                .pool_max_idle_per_host(1)
                .build()
                .map_err(|request_error| {
                    error("AI_IDEA_CLIENT_ERROR", request_error.to_string(), true)
                })
        })
        .clone()
}

fn video_task_limiter() -> Arc<tokio::sync::Semaphore> {
    VIDEO_TASK_LIMITER
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
}

fn error(code: &str, message: impl Into<String>, retryable: bool) -> String {
    json!({"code": code, "message": message.into(), "retryable": retryable}).to_string()
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("ai-settings.json"))
        .map_err(|e| error("AI_SETTINGS_PATH_ERROR", e.to_string(), false))
}

fn load_file(app: &tauri::AppHandle) -> Result<AiSettingsFile, String> {
    let path = settings_path(app)?;
    if !path.is_file() {
        return Ok(AiSettingsFile::default());
    }
    let bytes = fs::read(path).map_err(|e| error("AI_SETTINGS_READ_ERROR", e.to_string(), true))?;
    let mut settings: AiSettingsFile = serde_json::from_slice(&bytes)
        .map_err(|e| error("AI_SETTINGS_INVALID", e.to_string(), false))?;
    let is_legacy_builtin_prompt = settings
        .video_storyboard_prompt
        .starts_with("你是一名专业的影视导演、分镜师和视觉资产整理师。")
        && settings.video_storyboard_prompt.contains("一、全局角色库")
        && settings.video_storyboard_prompt.contains("三、分镜列表")
        && !settings.video_storyboard_prompt.contains("一、项目剧情");
    if is_legacy_builtin_prompt {
        settings.video_storyboard_prompt = DEFAULT_VIDEO_STORYBOARD_PROMPT.trim().into();
    }
    let is_previous_builtin_detailed_prompt = settings
        .video_storyboard_detailed_prompt
        .starts_with("你是一名专业的影视导演、分镜师和视觉资产整理师。")
        && settings
            .video_storyboard_detailed_prompt
            .contains("每段原则上 10～15 秒")
        && settings
            .video_storyboard_detailed_prompt
            .contains("第1段（0～15秒）")
        && settings
            .video_storyboard_detailed_prompt
            .contains("第2段（15～30秒）");
    if is_previous_builtin_detailed_prompt {
        settings.video_storyboard_detailed_prompt =
            DEFAULT_VIDEO_STORYBOARD_DETAILED_PROMPT.trim().into();
    }
    if settings.prompt_overrides.is_none() {
        settings.prompt_overrides = Some(PromptOverrideSettings {
            video_storyboard_prompt: settings.video_storyboard_prompt.trim()
                != DEFAULT_VIDEO_STORYBOARD_PROMPT.trim(),
            video_storyboard_detailed_prompt: settings.video_storyboard_detailed_prompt.trim()
                != DEFAULT_VIDEO_STORYBOARD_DETAILED_PROMPT.trim(),
            character_image_prompt: settings.character_image_prompt.trim()
                != DEFAULT_CHARACTER_IMAGE_PROMPT.trim(),
        });
    }
    Ok(settings)
}

fn credential() -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).map_err(|e| {
        error(
            "AI_CREDENTIAL_STORE_ERROR",
            format!("无法访问 Windows 凭据存储：{e}"),
            false,
        )
    })
}

fn load_api_key() -> Result<Option<String>, String> {
    match credential()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(error(
            "AI_CREDENTIAL_READ_ERROR",
            format!("无法读取 API Key：{e}"),
            false,
        )),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentAiConfig {
    pub base_url: String,
    pub agent_model: String,
    pub video_model: String,
    pub video_storyboard_prompt: String,
    pub video_storyboard_detailed_prompt: String,
    pub api_key: String,
}

pub(crate) fn load_agent_config(app: &tauri::AppHandle) -> Result<AgentAiConfig, String> {
    let settings = load_file(app)?;
    // Text requests now use the authenticated platform gateway, never a local key.
    crate::platform_session::current_user_id()?;
    let api_key = String::new();
    Ok(AgentAiConfig {
        base_url: settings.base_url,
        agent_model: "服务端默认文本大模型".to_owned(),
        video_model: "服务端默认视频理解大模型".to_owned(),
        video_storyboard_prompt: settings.video_storyboard_prompt,
        video_storyboard_detailed_prompt: settings.video_storyboard_detailed_prompt,
        api_key,
    })
}

fn extract_json_object(content: &str) -> Result<Value, String> {
    let trimmed = content.trim();
    let without_fence = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim()
        .strip_suffix("```")
        .unwrap_or(trimmed)
        .trim();
    serde_json::from_str(without_fence).or_else(|_| {
        let start = without_fence
            .find('{')
            .ok_or_else(|| error("AI_IDEA_RESPONSE_INVALID", "大模型未返回 JSON 对象", true))?;
        let end = without_fence
            .rfind('}')
            .ok_or_else(|| error("AI_IDEA_RESPONSE_INVALID", "大模型返回的 JSON 不完整", true))?;
        serde_json::from_str(&without_fence[start..=end]).map_err(|parse_error| {
            error(
                "AI_IDEA_RESPONSE_INVALID",
                format!("无法解析大模型返回的剧情 JSON：{parse_error}"),
                true,
            )
        })
    })
}

async fn openai_json_completion(
    _config: &AgentAiConfig,
    stage: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<Value, String> {
    let operation = match stage {
        "video_remix" => "二创剧情与分镜生成",
        "idea_story" | "guided_idea_outline" => "创意故事大纲生成",
        "guided_idea_episodes" => "创意分集剧情生成",
        "guided_idea_assets" => "创意角色与场景设定生成",
        "guided_episode_storyboard" | "idea_storyboard" => "创意分镜生成",
        "idea_long_foundation" => "长篇创作基础设定生成",
        "idea_long_outline" => "长篇分集大纲生成",
        "idea_long_segment" => "长篇分段剧情生成",
        _ => "文本生成 / 创意开发（每次调用单独确认）",
    };
    let response = crate::platform_media::text_completion(operation, json!({
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.35,
        "stream": false
    })).await?;
    // A successful upstream request is charged even if its content fails local
    // validation. Any correction is a new, separately confirmed paid request.
    let content = extract_openai_completion_content(&response.to_string()).or_else(|_| generated_text(&response))?;
    extract_json_object(&content)
}

fn extract_openai_completion_content(body: &str) -> Result<String, String> {
    let mut streamed = String::new();
    let mut saw_stream_event = false;
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        saw_stream_event = true;
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(content) = event
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .or_else(|| {
                event
                    .pointer("/choices/0/message/content")
                    .and_then(Value::as_str)
            })
        {
            streamed.push_str(content);
        }
    }
    if !streamed.trim().is_empty() {
        return Ok(streamed);
    }
    if saw_stream_event {
        return Err(error(
            "AI_IDEA_RESPONSE_INVALID",
            "文本大模型流式响应已结束，但没有返回内容",
            true,
        ));
    }
    let payload: Value = serde_json::from_str(body).map_err(|parse_error| {
        error(
            "AI_IDEA_RESPONSE_INVALID",
            format!("文本大模型接口返回无效 JSON：{parse_error}"),
            true,
        )
    })?;
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error("AI_IDEA_RESPONSE_INVALID", "文本大模型未返回内容", true))
}

fn is_retryable_text_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn text_retry_delay(failed_attempt: usize) -> Duration {
    Duration::from_secs(1_u64 << failed_attempt.saturating_sub(1).min(3))
}

fn text_request_error(endpoint: &str, request_error: &reqwest::Error) -> String {
    let detail = reqwest_error_detail(request_error);
    let (code, message) = if request_error.is_timeout() && request_error.is_connect() {
        (
            "AI_IDEA_CONNECT_TIMEOUT",
            format!("连接文本大模型接口超时 {endpoint}：{detail}"),
        )
    } else if request_error.is_timeout() {
        (
            "AI_IDEA_RESPONSE_TIMEOUT",
            format!("等待文本大模型响应超时 {endpoint}：{detail}"),
        )
    } else if request_error.is_body() {
        (
            "AI_IDEA_REQUEST_BODY_ERROR",
            format!("发送文本大模型请求数据失败 {endpoint}：{detail}"),
        )
    } else {
        (
            "AI_IDEA_CONNECTION_ERROR",
            format!("无法连接文本大模型接口 {endpoint}：{detail}"),
        )
    };
    error(code, message, true)
}

fn text_response_error(endpoint: &str, request_error: &reqwest::Error) -> String {
    let detail = reqwest_error_detail(request_error);
    let (code, message) = if request_error.is_timeout() {
        (
            "AI_IDEA_RESPONSE_TIMEOUT",
            format!("读取文本大模型响应超时 {endpoint}：{detail}"),
        )
    } else {
        (
            "AI_IDEA_RESPONSE_ERROR",
            format!("读取文本大模型响应失败 {endpoint}：{detail}"),
        )
    };
    error(code, message, true)
}

fn content_language_name(code: &str) -> &'static str {
    match code {
        "zh-TW" => "繁體中文",
        "en" => "English",
        "ja" => "日本語",
        "ko" => "한국어",
        "fr" => "Français",
        "es" => "Español",
        "pt" => "Português",
        "de" => "Deutsch",
        "bo" => "བོད་ཡིག",
        "ug" => "ئۇيغۇرچە",
        "mn" => "Монгол",
        _ => "简体中文",
    }
}

pub(crate) async fn generate_idea_story(
    app: &tauri::AppHandle,
    idea: &str,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let creative_type = creation_spec
        .get("creative_type_name")
        .and_then(Value::as_str)
        .unwrap_or("原创剧情");
    let creative_prompt = creation_spec
        .get("creative_type_prompt")
        .and_then(Value::as_str)
        .unwrap_or("围绕人物目标、冲突和选择代价创作完整剧情");
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_u64)
        .unwrap_or(60);
    openai_json_completion(
        &config,
        "idea_story",
        "你是专业影视编剧。你的任务仅是把一句话创意扩写成完整的项目剧情，暂时不要写分镜、景别、机位、运镜或画面提示词。必须只输出有效 JSON 对象，不要输出 Markdown。",
        &format!(
            "输出语言：{language}\n目标成片时长：约{target_duration}秒\n创作类型：{creative_type}\n该类型的剧情生成要求：{creative_prompt}\n用户的一句话创意：{idea}\n\n请输出：{{\"title\":\"\",\"logline\":\"\",\"genre\":[\"\"],\"theme\":\"\",\"synopsis\":\"按起因、发展、转折、高潮、结局完整描述剧情\",\"tone\":\"\",\"story_structure\":[{{\"stage\":\"\",\"description\":\"\"}}]}}。所有内容必须符合创作类型，但不得出现“根据提示词”“创作类型要求”等元话语。"
        ),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_video_remix(
    app: &tauri::AppHandle,
    source_analysis: &str,
    creative_direction: &str,
    originality: &str,
    storyboard_duration_mode: &str,
    target_duration: f64,
    aspect_ratio: &str,
    visual_style: &str,
    language_code: &str,
    revision_note: Option<&str>,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(language_code);
    let visual_style_instruction = if visual_style.trim().is_empty() {
        "由AI根据新剧情的题材、时代、情绪、受众和画面比例设计最合适的具体视觉风格；必须在canonical.story.visual_style中输出可直接用于生图的详细画风描述，并让所有shots.visual_style保持一致"
    } else {
        visual_style
    };
    let (expected_shots, storyboard_duration_rule) = match storyboard_duration_mode {
        "fixed" => (
            (target_duration / 10.0).ceil().max(1.0) as usize,
            "固定时长模式：从第1镜开始连续切分，除最后一个尾镜外，每个分镜时长必须严格等于10秒；当目标总时长不能被10整除时，只有最后一个尾镜使用精确剩余时长；不得用8秒、12秒、15秒等其他时长替代常规10秒分镜",
        ),
        "adaptive" => {
            let minimum = (target_duration / 15.0).ceil().max(1.0);
            let maximum = (target_duration / 8.0).floor().max(minimum);
            (
                (target_duration / 11.5).round().clamp(minimum, maximum) as usize,
                "非固定时长模式：必须依据情节动作、冲突节点和转折自然切分，每个分镜（包括最后一个）时长都必须在8～15秒之间；禁止不足8秒或超过15秒，所有分镜时长之和必须精确覆盖目标时长",
            )
        }
        _ => (
            (target_duration / 12.0).round().max(1.0) as usize,
            "兼容旧任务：每个常规分镜10～15秒，只有最后一个尾镜可不足10秒；所有分镜时长之和必须精确覆盖目标时长",
        ),
    };
    let originality_rule = match originality {
        "radical" => "激进原创（强冲突多反转）：核心主题、价值立场、关注群体和情绪诉求必须保持一致，但原分镜的表层剧情、人物关系、世界观、事件链、场景、关键道具和结局必须剧烈重构。必须设计至少3个逐级加压且不可轻易撤销的冲突升级节点，并设计至少2次有前因铺垫、会改变人物目标/观众认知/局势优势的有效反转；冲突要迫使人物付出真实代价并做艰难选择，最终高潮必须解决核心对抗。禁止只靠误会、巧合、突然出现的新人物或无铺垫身份揭露制造伪反转。conflict_design必须逐项列出至少3个冲突节点，reversal_design必须逐项列出至少2次反转，并写明对应剧情节点或分镜ID",
        "high" => "高度原创：核心主题、价值立场、关注群体和情绪诉求必须保持一致；在同一主题范围内重构人物身份、动机、场景和具体事件，保留原稿有效的冲突升级或情绪递进功能",
        _ => "平衡改编：保持核心主题、价值立场、关注群体和情绪诉求，借鉴叙事节奏、论述结构或矛盾结构，但不得照搬角色姓名、标志性台词、独特场景或连续事件",
    };
    let retry_correction = revision_note
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("\n上一次结果校验未通过，必须修正：{value}"))
        .unwrap_or_default();
    let radical_override = if originality == "radical" {
        "\n\n【激进原创最高优先级覆盖规则】本任务明确要求强冲突、多反转。此规则覆盖用户默认二创方向中“如原稿包含矛盾或反转才保留”的表述，也覆盖后文“原稿无反转时不得强行添加”的普通模式规则。无论参考稿原本是否存在反转，新剧情都必须主动重构出至少3轮逐级升级的核心冲突和至少2次有效反转，并落实到实际story.beats、episodes和shots中。adaptation_notes必须严格输出为：source_structure字符串数组、conflict_design至少3条字符串的数组、reversal_design至少2条字符串的数组、originality_statement字符串；不得省略reversal_design，也不得写“原稿无反转所以不设计反转”。"
    } else {
        ""
    };
    let correction = format!("{radical_override}{retry_correction}");
    openai_json_completion(
        &config,
        "video_remix",
        "你是擅长短剧、电影和漫剧的原创编剧兼分镜导演。二次创作必须以参考稿的核心主题为锚点：先识别其价值立场、主要议题、关注对象、核心主张和希望观众产生的情绪，再在同一主题范围内创作新的故事表达。人物、场景、事件和台词需要原创，但不得把主题替换成无关的灾难、犯罪、悬疑、爱情或其他题材。参考稿只用于主题与叙事功能学习，禁止改名式洗稿、逐场景映射、复用标志性台词或连续复制具体情节。平衡改编和高度原创应服从原稿真实存在的结构，原稿没有强冲突或反转时不得强行添加；但当原创强度为“激进原创（强冲突多反转）”时，这是用户明确要求的结构重构，必须在保留主题的前提下主动建立高强度核心对抗、至少3轮冲突升级和至少2次有效反转，不能再以“原稿没有反转”为由省略。每次反转都要有前置线索、因果触发和后续影响，并落实到story.beats、episodes和具体shots中。必须把实际台词独立写入每个分镜的dialogue字段并标明说话角色，同时把每一位说话人的台词原文直接内化到同一分镜的visual画面描述中，格式为“角色A说：‘XXXXX’”或“角色A说（具体语气）：‘XXXXX’”；video_prompt中的“台词”必须与dialogue完全一致。允许纯环境或过渡镜头写“无”，但整个二创项目至少一个分镜必须有推动剧情、表达观点或传递情绪的具体对白、独白或旁白，严禁所有分镜都写“无”。只输出有效JSON对象，不要输出Markdown。",
        &format!(
            "输出语言：{language}\n目标成片时长：{target_duration}秒\n画面比例：{aspect_ratio}\n项目画风要求：{visual_style_instruction}\n分镜时长规则：{storyboard_duration_rule}\n要求分镜数：约{expected_shots}个\n原创强度：{originality_rule}\n用户二创方向：{creative_direction}\n\n参考视频解析稿：\n{source_analysis}\n{correction}\n\n【主题继承硬性规则】先提取参考稿的核心主题、价值立场、关注群体、核心主张与情绪目标。新故事的theme、logline、synopsis和结局必须继续表达这些内容，不能仅保留抽象的“牺牲、选择、反转”等结构词。除非用户二创方向明确要求更换主题，否则不得改变议题对象或价值立场。例如参考稿为农民群体发声，新故事仍必须以农民的贡献、处境或尊严为核心，不能改写成与农民无关的城市排洪故事。\n【结构适配规则】只继承参考稿真实存在的叙事功能：有矛盾则重构矛盾，有反转则重构反转；若原稿是事实列举、观点递进、历史回顾、情绪控诉或价值倡议，则使用事实揭示、认知递进、人物见证和情绪高潮完成二创，不得强行虚构无关反转。\n\n输出顶层字段title、logline、synopsis、adaptation_notes、canonical。adaptation_notes包含source_structure、conflict_design、reversal_design、originality_statement；source_structure首先说明保留的核心主题和价值立场，再说明真实存在的叙事结构；若原稿没有冲突或反转，conflict_design或reversal_design应明确写“原稿无强冲突/反转，改用情绪或认知递进”，不得虚构结构借鉴点。originality_statement必须同时说明哪些主题内容被保留、哪些具体表达被重构。canonical必须包含story、episodes、characters、scenes、sequences、shots：story包含title、logline、genre、theme、synopsis、tone、aspect_ratio、visual_style、beats；episodes至少1集，包含id、order、title、duration、content；characters使用CHAR_001起的稳定ID和完整字段，appearance必须是含face、hair、body、clothes、accessories五个非空字符串的对象。每个角色的states至少一个，每个state必须完整包含id、name、trigger、description、appearance_lock、clothing_lock、reference_assets、locked；name写明确的状态名称，trigger写该状态在剧情中的出现条件，appearance_lock写该状态不可改变的脸型、五官、发型和体态，clothing_lock写该状态不可改变的服装、道具、装备与配饰（没有则明确写“无”），这些字段均不得为空。角色默认只能有一个状态；只有穿着/服装、随身道具/装备或年龄阶段发生明确且明显的可见变化时，才允许为同一角色生成多个states。仅情绪、表情、动作、姿势、地点、场景、时间、普通伤势或剧情阶段变化不得拆分状态；凡人/变身等名称也只有在服装、道具或年龄实际变化时才能拆分。若生成多个状态，每个状态必须具体写明上述可见差异。scenes使用SCENE_001起的稳定ID并具体描述空间、材质、陈设、出入口和光线；sequences与shots使用稳定ID并正确互相引用。shots[].sequence_id只能填写canonical.sequences数组中真实存在的SEQ_编号，绝不能填写scene_id、场景名称或自行创建的编号；shots[].scene_id必须与其所属sequence.scene_id完全一致。每个sequence和shot的character_ids必须始终是角色ID字符串组成的JSON数组，即使没有角色也必须输出[]，严禁输出单个字符串、对象或省略该字段；每个shot的character_state_ids必须是角色ID到状态ID的JSON对象，严禁输出数组或“角色ID:状态ID”字符串。shots必须包含Canonical完整分镜字段及character_state_ids，并严格遵守上面的分镜时长规则，所有分镜总时长必须精确等于{target_duration}秒。每个visual必须写出可拍摄的具体人物、空间、构图、光线和事件，并把该分镜dialogue中每一位说话人的台词原文直接写成“角色A说：‘XXXXX’”或“角色A说（具体语气）：‘XXXXX’”；action必须是具体动作链；不得出现“按剧情呈现”“自然运镜”“人物自然行动”“待补充”“同上”等占位内容。冲突升级和反转的数量必须服从原稿结构及用户二创方向，禁止为了凑模板强行添加。image_prompt只组合具体画面和统一画风；video_prompt逐行写明运镜、画面、动作、台词、声音、约束和项目画风。"
        ),
    )
    .await
}

pub(crate) async fn generate_idea_canonical(
    app: &tauri::AppHandle,
    story: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(60.0)
        .clamp(15.0, 600.0);
    let expected_shots = if target_duration <= 15.0 {
        1
    } else if target_duration < 20.0 {
        2
    } else {
        (target_duration / 10.0).floor() as usize
    };
    let aspect_ratio = creation_spec
        .get("aspect_ratio")
        .and_then(Value::as_str)
        .unwrap_or("9:16");
    let visual_style = creation_spec
        .get("visual_style")
        .and_then(Value::as_str)
        .unwrap_or("电影级统一视觉风格");
    openai_json_completion(
        &config,
        "idea_storyboard",
        "你是专业影视导演和分镜师。根据已经完成的整体剧情设计角色、场景和分镜。不得再接收或复述创作类型提示词。必须只输出有效 JSON 对象，不要输出 Markdown。",
        &format!(
            "输出语言：{language}\n目标成片时长：{target_duration}秒\n建议分镜数量：约{expected_shots}个\n屏幕比例：{aspect_ratio}\n项目画风：{visual_style}\n整体剧情 JSON：{story}\n\n输出 Canonical JSON，顶层只能包含 story、characters、scenes、sequences、shots。story沿用给定剧情并增加aspect_ratio和visual_style。characters包含id、name、role、gender、age_range、appearance(face/hair/body/clothes/accessories)、voice、appearance_lock、clothing_lock、voice_lock、story_function、locked、reference_assets、states；不要输出人物性格和核心动机。每个角色至少有一个完整state；默认只能生成一个状态，只有穿着/服装、随身道具/装备或年龄阶段发生明确且明显的可见变化时才生成多个states。情绪、表情、动作、姿势、地点、场景、时间、普通伤势或剧情阶段变化不得拆状态。scenes包含id、name、location_type、time_of_day、description、lighting、layout、props、mood、locked、reference_assets。sequences包含id、scene_id、order、summary、character_ids、shot_ids。shots包含id、sequence_id、scene_id、character_ids、character_state_ids、duration、aspect_ratio、shot_size、camera_angle、camera_movement、visual_style、scene_lock、character_lock、visual、action、emotion、dialogue、sound、image_prompt、video_prompt、negative_prompt、constraints、status、locked。\n\n硬性规则：每个分镜时长应为10～15秒，仅最后一个分镜可以不足10秒；所有分镜总时长覆盖目标时长。每个visual都使用该分镜自己的局部时间轴并从0秒开始，拆成2～4个连续子段，例如0～4秒、4～10秒，最后必须结束于本分镜duration，绝不能使用整片全局秒数。shot_size、camera_angle、camera_movement及全部文案必须使用“{language}”显示，不得混入英文枚举代码。image_prompt只组合visual与项目画风；video_prompt组合运镜、画面、动作、台词、声音、约束和项目画风。创作类型名称或提示词不得直接写入visual、image_prompt或video_prompt。"
        ),
    )
    .await
}

pub(crate) async fn generate_long_idea_foundation(
    app: &tauri::AppHandle,
    story: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(600.0)
        .clamp(181.0, 3600.0);
    let chunk_duration = creation_spec
        .get("long_form_chunk_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(90.0)
        .clamp(60.0, 90.0);
    let chapter_count = (target_duration / 300.0).ceil().clamp(2.0, 16.0) as usize;
    let aspect_ratio = creation_spec
        .get("aspect_ratio")
        .and_then(Value::as_str)
        .unwrap_or("9:16");
    let visual_style = creation_spec
        .get("visual_style")
        .and_then(Value::as_str)
        .unwrap_or("电影级统一视觉风格");
    openai_json_completion(
        &config,
        "idea_long_foundation",
        "你是长篇影视项目的总编剧和连续性统筹。根据已经完成的整体剧情建立精炼、可执行的创作圣经、角色库、场景库和章节大纲。不要生成分镜或分段任务。只输出有效JSON对象，不要输出Markdown。",
        &format!(
            "输出语言：{language}\n全片时长：{target_duration}秒\n屏幕比例：{aspect_ratio}\n项目画风：{visual_style}\n建议章节数：{chapter_count}\n后续会按每{chunk_duration}秒拆分任务，本步骤不要输出segments或shots。\n整体剧情：{story}\n\n只输出story、characters、scenes、chapters、initial_continuity_state。story沿用整体剧情并补充aspect_ratio、visual_style。characters使用完整Canonical角色字段并使用稳定ID CHAR_001起；每个角色的appearance必须是对象，且必须包含face、hair、body、clothes、accessories五个字符串字段，严禁把appearance输出为字符串或数组；不得包含人物性格和核心动机。每个角色至少有一个完整state；默认只能生成一个状态，只有穿着/服装、随身道具/装备或年龄阶段发生明确且明显的可见变化时才生成多个states，情绪、表情、动作、姿势、地点、场景、时间、普通伤势或剧情阶段变化不得拆状态。scenes使用完整Canonical场景字段并使用稳定ID SCENE_001起。chapters包含id、order、title、duration、summary、start_state、end_state、character_ids、scene_ids，所有章节时长总和精确等于{target_duration}秒，剧情首尾连续并覆盖完整故事。initial_continuity_state包含timeline、character_states、prop_states、unresolved_threads、last_image。内容保持精炼，避免重复整体剧情。"
        ),
    )
    .await
}

pub(crate) async fn generate_long_idea_outline(
    app: &tauri::AppHandle,
    foundation: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(600.0)
        .clamp(181.0, 3600.0);
    let chunk_duration = creation_spec
        .get("long_form_chunk_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(90.0)
        .clamp(60.0, 90.0);
    let segment_count = (target_duration / chunk_duration).ceil() as usize;
    let compact_foundation = json!({
        "story": foundation.get("story").cloned().unwrap_or(Value::Null),
        "chapters": foundation.get("chapters").cloned().unwrap_or_else(|| json!([])),
        "characters": foundation.get("characters").and_then(Value::as_array).map(|items| items.iter().map(|item| json!({
            "id": item.get("id"),
            "name": item.get("name"),
            "story_function": item.get("story_function"),
        })).collect::<Vec<_>>()).unwrap_or_default(),
        "scenes": foundation.get("scenes").and_then(Value::as_array).map(|items| items.iter().map(|item| json!({
            "id": item.get("id"),
            "name": item.get("name"),
            "description": item.get("description"),
        })).collect::<Vec<_>>()).unwrap_or_default(),
    });
    openai_json_completion(
        &config,
        "idea_long_outline",
        "你是长篇影视项目的分段规划师。只把已经确认的章节大纲拆成连续、可逐段执行的剧情任务，不要生成具体分镜。只输出有效JSON对象，不要输出Markdown。",
        &format!(
            "输出语言：{language}\n全片时长：{target_duration}秒\n必须生成{segment_count}个segments\n常规分段时长：{chunk_duration}秒\n创作基础设定：{compact_foundation}\n\n只输出{{\"segments\":[...]}}。每个segment包含id、order、chapter_id、duration、summary、beats、start_state、end_state、character_ids、scene_ids、continuity_requirements。segments数量必须精确为{segment_count}；除最后一段外每段为{chunk_duration}秒，最后一段使用剩余时长，总和必须精确等于{target_duration}秒。相邻分段的end_state与start_state必须衔接，完整覆盖章节剧情，不得重复事件，不得新增基础设定中不存在的角色ID或场景ID。内容保持精炼，每段summary和beats只描述本段推进。"
        ),
    )
    .await
}

pub(crate) async fn generate_long_idea_segment(
    app: &tauri::AppHandle,
    bible: &Value,
    segment: &Value,
    previous_summary: &Value,
    continuity_state: &Value,
    next_segment: Option<&Value>,
    shot_start: usize,
    revision_note: Option<&str>,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let duration = segment
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(90.0);
    let expected_shots = (duration / 12.0).round().max(1.0) as usize;
    let next_goal = next_segment
        .map(Value::to_string)
        .unwrap_or_else(|| "这是全片最后一个分段，完成结局并收束伏笔".to_owned());
    let correction = revision_note
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("\n上一次结果存在以下问题，必须修正：{value}"))
        .unwrap_or_default();
    openai_json_completion(
        &config,
        "idea_long_segment",
        "你是长篇影视项目的分镜导演和连续性统筹。只负责当前分段，不得提前重演或改写已完成剧情。严格遵守创作圣经、上一段结束状态和当前任务，只输出有效JSON对象。",
        &format!(
            "输出语言：{language}\n创作圣经：{bible}\n当前分段任务：{segment}\n上一分段摘要：{previous_summary}\n进入当前分段前的连续性状态：{continuity_state}\n下一分段衔接目标：{next_goal}\n当前分镜起始编号：{shot_start}\n建议分镜数量：约{expected_shots}个{correction}\n\n输出字段：sequence、shots、segment_summary、continuity_state、continuity_check。sequence包含scene_id、summary、character_ids、shot_ids。shots使用Canonical分镜完整字段；每个分镜10～15秒，只有当前分段最后一个分镜可不足10秒，所有shots时长之和必须精确等于当前分段duration。每个分镜visual内部时间轴必须从0秒开始并结束于该分镜duration。角色和场景只能引用创作圣经中的稳定ID。image_prompt只包含画面和项目画风；video_prompt逐行组合运镜、画面、动作、台词、声音、约束、项目画风。continuity_state必须完整记录本段结束后的timeline、character_states、prop_states、unresolved_threads、last_image。continuity_check包含valid和issues，并在输出前自行检查人物位置、服装、伤势、知识、道具、伏笔和时间是否与上一状态连续。"
        ),
    )
    .await
}

pub(crate) async fn generate_guided_idea_outline(
    app: &tauri::AppHandle,
    idea: &str,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let target_duration = creation_spec
        .get("target_duration")
        .and_then(Value::as_f64)
        .unwrap_or(600.0);
    let creative_type = creation_spec
        .get("creative_type_name")
        .and_then(Value::as_str)
        .unwrap_or("剧情片");
    let creative_prompt = creation_spec
        .get("creative_type_prompt")
        .and_then(Value::as_str)
        .unwrap_or("遵循完整的戏剧结构与人物行动逻辑");
    openai_json_completion(
        &config,
        "guided_idea_outline",
        "你是影视项目总编剧。先只创作可供用户确认的全片故事大纲，不要拆分集，不要生成角色表、场景表或分镜。只输出有效JSON对象，不要输出Markdown。",
        &format!(
            "输出语言：{language}\n用户Idea：{idea}\n创作类型：{creative_type}\n类型要求：{creative_prompt}\n目标成片时长：{target_duration}秒\n\n输出story对象，包含title、logline、genre、theme、synopsis、tone。synopsis必须是完整、具体、按时间顺序展开的整体大纲，包含开端、发展、转折、高潮和结局，人物必须有明确行动与因果，不得超过3000个汉字，不得包含分镜术语、占位语、写作说明或“待补充”等内容。"
        ),
    )
    .await
}

pub(crate) async fn generate_guided_idea_episodes(
    app: &tauri::AppHandle,
    story: &Value,
    episode_count: usize,
    target_duration: f64,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let duration_requirement = if target_duration < 60.0 && episode_count == 1 {
        format!("必须拆成1集，该集时长为{target_duration}秒。")
    } else {
        format!("必须拆成{episode_count}集，每集约60至120秒。")
    };
    openai_json_completion(
        &config,
        "guided_idea_episodes",
        "你是影视剧集编剧。把用户已经确认的整体大纲拆成连续分集，只写每集实际发生的完整剧情，不生成角色表、场景表或分镜。只输出有效JSON对象。",
        &format!(
            "输出语言：{language}\n已确认整体大纲：{story}\n总时长：{target_duration}秒\n{duration_requirement}\n\n只输出{{\"episodes\":[...]}}。每集包含id、order、title、duration、content。content必须具体描述本集从开场到结尾实际发生的事件、人物行动、冲突、关键对白意图、转折和结尾钩子；相邻分集严格承接且不得重复剧情；完整覆盖整体大纲。严禁使用“剧情继续”“按大纲呈现”“人物展开行动”“待补充”等概括或占位表达。"
        ),
    )
    .await
}

pub(crate) async fn generate_guided_idea_assets(
    app: &tauri::AppHandle,
    story: &Value,
    episodes: &Value,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    openai_json_completion(
        &config,
        "guided_idea_assets",
        "你是影视项目设定统筹。只从全部已确认分集里提取实际出现的角色与场景，建立可直接用于分镜和生图的一致性设定。只输出有效JSON对象。",
        &format!(
            "输出语言：{language}\n整体大纲：{story}\n全部分集：{episodes}\n\n只输出characters和scenes。characters必须使用稳定ID CHAR_001起，并包含id、name、role、gender、age_range、appearance、voice、appearance_lock、clothing_lock、voice_lock、story_function、locked、reference_assets、states；appearance必须是包含face、hair、body、clothes、accessories五个详细字符串字段的对象。states至少包含一个状态；每个状态包含id、name、trigger、description、appearance_lock、clothing_lock、locked、reference_assets。角色默认只能生成一个状态；只有穿着/服装、随身道具/装备或年龄阶段发生明确且明显的可见变化时，才拆成同一角色下的多个states，不能复制成多个角色。仅情绪、表情、动作、姿势、地点、场景、时间、普通伤势或剧情阶段变化不得拆状态；凡人/神变、变身前/后、伪装等名称只有在服装、道具或年龄实际变化时才能拆分。状态ID使用对应角色ID加_STATE_001起。多个状态的description必须逐一明确写出服装、道具或年龄差异，且每个状态能单独用于角色生图。scenes必须使用稳定ID SCENE_001起，并包含id、name、location_type、time_of_day、description、lighting、layout、props、mood、locked、reference_assets；description必须具体描述空间结构、材质、主要陈设、出入口及可识别视觉特征，不能只写场景名称或“按剧情设定”。只提取分集中真实出现且有叙事作用的内容。"
        ),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_guided_episode_storyboard(
    app: &tauri::AppHandle,
    story: &Value,
    episode: &Value,
    characters: &Value,
    scenes: &Value,
    previous_summary: &Value,
    continuity_state: &Value,
    shot_start: usize,
    revision_note: Option<&str>,
    creation_spec: &Value,
) -> Result<Value, String> {
    let config = load_agent_config(app)?;
    let language = content_language_name(
        creation_spec
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN"),
    );
    let duration = episode
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(90.0);
    let expected_shots = (duration / 12.0).round().max(1.0) as usize;
    let expected_shot_duration = duration / expected_shots as f64;
    let correction = revision_note
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("\n上一次结果不合格，必须逐项修正：{value}"))
        .unwrap_or_default();
    openai_json_completion(
        &config,
        "guided_episode_storyboard",
        "你是专业影视分镜导演。把当前分集的具体剧情逐事件转换成可拍摄分镜，不得使用模板句、抽象概括或重复镜头。只输出有效JSON对象。",
        &format!(
            "输出语言：{language}\n整体大纲：{story}\n当前分集：{episode}\n项目角色：{characters}\n项目场景：{scenes}\n上一集摘要：{previous_summary}\n连续性状态：{continuity_state}\n分镜起始编号：{shot_start}\n必须生成恰好{expected_shots}个分镜，每个分镜约{expected_shot_duration:.2}秒；所有duration相加必须精确等于{duration}秒{correction}\n\n输出sequence、shots、episode_summary、continuity_state。sequence包含scene_id、summary、character_ids、shot_ids。每个shot包含完整Canonical分镜字段，并增加character_state_ids对象，格式为角色ID到状态ID的映射；shot中每个character_id都必须选择该角色states里的一个状态。只有给定states中确实存在穿着、随身道具/装备或年龄差异，并且该可见变化已在剧情中完成时，才改用对应状态ID；情绪、表情、动作、地点或普通伤势变化不得切换状态。visual、action和character_lock必须与所选状态一致。每个分镜10至15秒，仅本集最后一个可不足10秒，shots总时长必须精确等于当前分集的{duration}秒，不得按剧情内容自行增加总时长。visual必须用2至4个从0秒开始的局部时间段，逐段写清人物位置、表情、动作、环境变化和构图；action必须描述本镜真实动作与结果；dialogue按剧情写具体台词，没有台词才写“无”；camera_movement、shot_size和camera_angle必须根据本镜事件具体选择。严禁出现“按当前剧情大纲呈现画面”“人物按剧情自然行动”“根据剧情自然运镜”“符合当前剧情”等占位句。每个分镜必须推进当前分集的一个明确事件，相邻分镜不得复制visual、action或video_prompt。只能引用给定角色、状态和场景ID。"
        ),
    )
    .await
}

fn settings_view(
    settings: AiSettingsFile,
    model_catalog: Vec<crate::database::model_catalog::AiModelCatalogItem>,
) -> Result<AiSettingsView, String> {
    let prompt_overrides = settings.prompt_overrides.clone().unwrap_or_default();
    let api_key = load_api_key()?;
    let api_key_mask = api_key.as_ref().map(|key| {
        let suffix: String = key
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("••••••••{suffix}")
    });
    Ok(AiSettingsView {
        base_url: settings.base_url,
        agent_model: settings.agent_model,
        video_model: settings.video_model,
        video_storyboard_prompt: settings.video_storyboard_prompt,
        video_storyboard_detailed_prompt: settings.video_storyboard_detailed_prompt,
        character_image_prompt: settings.character_image_prompt,
        prompt_overrides,
        image_model: settings.image_model,
        image_protocol: settings.image_protocol,
        video_generation_model: settings.video_generation_model,
        video_generation_protocol: settings.video_generation_protocol,
        credit_costs: settings.credit_costs,
        model_catalog,
        has_api_key: api_key.is_some(),
        api_key_mask,
    })
}

fn normalize_settings(input: &SaveAiSettingsInput) -> Result<AiSettingsFile, String> {
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let parsed = Url::parse(&base_url)
        .map_err(|_| error("AI_BASE_URL_INVALID", "接口基础地址不是有效 URL", false))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(error(
            "AI_BASE_URL_INVALID",
            "接口基础地址必须是无查询参数的 HTTP(S) 地址",
            false,
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(error(
            "AI_BASE_URL_INVALID",
            "接口基础地址不能包含用户名或密码",
            false,
        ));
    }

    let agent_model = input.agent_model.trim().to_string();
    if agent_model.is_empty()
        || agent_model.len() > 120
        || !agent_model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(error("AI_AGENT_MODEL_INVALID", "Agent 模型名称无效", false));
    }
    let video_model = input.video_model.trim().to_string();
    if video_model.is_empty()
        || video_model.len() > 120
        || !video_model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(error("AI_MODEL_INVALID", "视频理解模型名称无效", false));
    }
    let image_model = input.image_model.trim().to_string();
    if image_model.is_empty()
        || image_model.len() > 160
        || !image_model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(error("AI_IMAGE_MODEL_INVALID", "生图模型名称无效", false));
    }
    let image_protocol = input.image_protocol.trim().to_ascii_lowercase();
    if !matches!(image_protocol.as_str(), "openai" | "gemini" | "media") {
        return Err(error(
            "AI_IMAGE_PROTOCOL_INVALID",
            "生图接口协议必须是 OpenAI、Gemini 或平台媒体任务",
            false,
        ));
    }
    let video_generation_model = input.video_generation_model.trim().to_string();
    if video_generation_model.is_empty()
        || video_generation_model.len() > 160
        || !video_generation_model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(error(
            "AI_VIDEO_GENERATION_MODEL_INVALID",
            "视频生成模型名称无效",
            false,
        ));
    }
    let video_generation_protocol = input.video_generation_protocol.trim().to_ascii_lowercase();
    if video_generation_protocol != "media" {
        return Err(error(
            "AI_VIDEO_GENERATION_PROTOCOL_INVALID",
            "视频生成接口协议必须是平台异步媒体任务模式",
            false,
        ));
    }
    let video_storyboard_prompt = input.video_storyboard_prompt.trim().to_string();
    let prompt_length = video_storyboard_prompt.chars().count();
    if !(50..=50_000).contains(&prompt_length) {
        return Err(error(
            "AI_VIDEO_PROMPT_INVALID",
            "视频理解提示词长度必须在 50 到 50000 个字符之间",
            false,
        ));
    }
    let video_storyboard_detailed_prompt =
        input.video_storyboard_detailed_prompt.trim().to_string();
    let detailed_prompt_length = video_storyboard_detailed_prompt.chars().count();
    if !(50..=50_000).contains(&detailed_prompt_length) {
        return Err(error(
            "AI_VIDEO_DETAILED_PROMPT_INVALID",
            "详细模式视频理解提示词长度必须在 50 到 50000 个字符之间",
            false,
        ));
    }
    let character_image_prompt = input.character_image_prompt.trim().to_string();
    let character_prompt_length = character_image_prompt.chars().count();
    if !(50..=20_000).contains(&character_prompt_length) {
        return Err(error(
            "AI_CHARACTER_IMAGE_PROMPT_INVALID",
            "角色生图提示词长度必须在 50 到 20000 个字符之间",
            false,
        ));
    }
    let default_credit_costs = CreditCostSettings::default();
    if !input.credit_costs.image_per_item.is_finite()
        || !(0.0..=1_000_000.0).contains(&input.credit_costs.image_per_item)
    {
        return Err(error(
            "AI_CREDIT_COST_INVALID",
            "每张图片的积分消耗必须是 0 到 1000000 之间的数字",
            false,
        ));
    }
    let mut video_per_second = std::collections::HashMap::new();
    for resolution in ["default", "480p", "720p", "768P", "1080p", "2K", "4K"] {
        let cost = input
            .credit_costs
            .video_per_second
            .get(resolution)
            .copied()
            .or_else(|| {
                default_credit_costs
                    .video_per_second
                    .get(resolution)
                    .copied()
            })
            .unwrap_or_default();
        if !cost.is_finite() || !(0.0..=1_000_000.0).contains(&cost) {
            return Err(error(
                "AI_CREDIT_COST_INVALID",
                format!("{resolution} 视频每秒积分消耗必须是 0 到 1000000 之间的数字"),
                false,
            ));
        }
        video_per_second.insert(resolution.to_owned(), cost);
    }
    Ok(AiSettingsFile {
        base_url,
        agent_model,
        video_model,
        video_storyboard_prompt,
        video_storyboard_detailed_prompt,
        character_image_prompt,
        prompt_overrides: Some(input.prompt_overrides.clone()),
        image_model,
        image_protocol,
        video_generation_model,
        video_generation_protocol,
        credit_costs: CreditCostSettings {
            image_per_item: input.credit_costs.image_per_item,
            video_per_second,
        },
    })
}

#[tauri::command]
pub fn get_ai_settings(app: tauri::AppHandle) -> Result<AiSettingsView, String> {
    let catalog = crate::database::model_catalog::list(&app)?;
    settings_view(load_file(&app)?, catalog)
}

#[tauri::command]
pub fn save_ai_settings(
    app: tauri::AppHandle,
    input: SaveAiSettingsInput,
) -> Result<AiSettingsView, String> {
    let mut settings = normalize_settings(&input)?;
    let catalog = crate::database::model_catalog::list(&app)?;
    if !catalog
        .iter()
        .any(|item| item.capability == "agent" && item.model == settings.agent_model)
    {
        return Err(error(
            "AI_AGENT_MODEL_INVALID",
            "请选择模型列表中的 Agent 模型",
            false,
        ));
    }
    if !catalog
        .iter()
        .any(|item| item.capability == "video" && item.model == settings.video_model)
    {
        return Err(error(
            "AI_MODEL_INVALID",
            "请选择模型列表中的视频理解模型",
            false,
        ));
    }
    let image_mapping = catalog
        .iter()
        .find(|item| item.capability == "image" && item.model == settings.image_model)
        .ok_or_else(|| {
            error(
                "AI_IMAGE_MODEL_INVALID",
                "请选择模型列表中的图片生成模型",
                false,
            )
        })?;
    settings.image_protocol = image_mapping.protocol.clone();
    let video_generation_mapping = catalog
        .iter()
        .find(|item| {
            item.capability == "video_generation" && item.model == settings.video_generation_model
        })
        .ok_or_else(|| {
            error(
                "AI_VIDEO_GENERATION_MODEL_INVALID",
                "请选择模型列表中的视频生成模型",
                false,
            )
        })?;
    settings.video_generation_protocol = video_generation_mapping.protocol.clone();
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| error("AI_SETTINGS_WRITE_ERROR", e.to_string(), true))?;
    }
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|e| error("AI_SETTINGS_WRITE_ERROR", e.to_string(), false))?;
    fs::write(path, bytes).map_err(|e| error("AI_SETTINGS_WRITE_ERROR", e.to_string(), true))?;

    let entry = credential()?;
    if input.clear_api_key {
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                return Err(error(
                    "AI_CREDENTIAL_WRITE_ERROR",
                    format!("无法删除 API Key：{e}"),
                    false,
                ))
            }
        }
    } else if let Some(api_key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        entry.set_password(api_key).map_err(|e| {
            error(
                "AI_CREDENTIAL_WRITE_ERROR",
                format!("无法安全保存 API Key：{e}"),
                false,
            )
        })?;
    }
    settings_view(settings, catalog)
}

pub(crate) fn mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => Some("video/mp4"),
        "mpeg" | "mpg" => Some("video/mpeg"),
        "mov" => Some("video/mov"),
        "avi" => Some("video/avi"),
        "flv" => Some("video/x-flv"),
        "webm" => Some("video/webm"),
        "wmv" => Some("video/wmv"),
        "3gp" | "3gpp" => Some("video/3gpp"),
        _ => None,
    }
}

fn api_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn openai_api_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{}{}", base, path.strip_prefix("/v1").unwrap_or(path))
    } else {
        format!("{base}{path}")
    }
}

fn is_lingke_relay(base_url: &str) -> bool {
    Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| host.eq_ignore_ascii_case("api.lk888.ai"))
}

fn response_error(status: StatusCode, value: &Value) -> String {
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("大模型接口返回了未识别的错误");
    error(
        "AI_PROVIDER_ERROR",
        format!("接口请求失败（{}）：{}", status.as_u16(), message),
        status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
    )
}

async fn send_json(
    client: &Client,
    url: &str,
    api_key: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| error("AI_NETWORK_ERROR", format!("无法连接大模型接口：{e}"), true))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| {
        error(
            "AI_RESPONSE_INVALID",
            format!("接口返回的内容不是有效 JSON：{e}"),
            true,
        )
    })?;
    if !status.is_success() {
        return Err(response_error(status, &value));
    }
    Ok(value)
}

pub(crate) fn generated_text(response: &Value) -> Result<String, String> {
    let text = response
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|candidate| {
            candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
        })
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        let reason = response
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN");
        return Err(error(
            "AI_EMPTY_RESPONSE",
            format!("模型没有返回文本，结束原因：{reason}"),
            true,
        ));
    }
    Ok(text)
}

async fn upload_large_video(
    client: &Client,
    settings: &AiSettingsFile,
    api_key: &str,
    path: &Path,
    mime: &str,
    size: u64,
) -> Result<(String, String), String> {
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("video");
    let start_url = api_url(&settings.base_url, "/upload/v1beta/files");
    let response = client
        .post(start_url)
        .header("x-goog-api-key", api_key)
        .header("X-Goog-Upload-Protocol", "resumable")
        .header("X-Goog-Upload-Command", "start")
        .header("X-Goog-Upload-Header-Content-Length", size)
        .header("X-Goog-Upload-Header-Content-Type", mime)
        .json(&json!({"file": {"display_name": display_name}}))
        .send()
        .await
        .map_err(|e| {
            error(
                "AI_UPLOAD_START_ERROR",
                format!("无法创建视频上传任务：{e}"),
                true,
            )
        })?;
    let status = response.status();
    let headers: HeaderMap = response.headers().clone();
    if !status.is_success() {
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        return Err(response_error(status, &value));
    }
    let upload_url = headers
        .get("x-goog-upload-url")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error("AI_UPLOAD_PROTOCOL_ERROR", "接口没有返回视频上传地址", true))?;

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| error("VIDEO_READ_ERROR", format!("无法读取视频文件：{e}"), false))?;
    let upload = client
        .post(upload_url)
        .header("Content-Length", size)
        .header("X-Goog-Upload-Offset", "0")
        .header("X-Goog-Upload-Command", "upload, finalize")
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
        .send()
        .await
        .map_err(|e| error("AI_UPLOAD_ERROR", format!("视频上传失败：{e}"), true))?;
    let upload_status = upload.status();
    let value: Value = upload.json().await.map_err(|e| {
        error(
            "AI_UPLOAD_PROTOCOL_ERROR",
            format!("无法读取上传结果：{e}"),
            true,
        )
    })?;
    if !upload_status.is_success() {
        return Err(response_error(upload_status, &value));
    }
    let file_name = value
        .pointer("/file/name")
        .and_then(Value::as_str)
        .ok_or_else(|| error("AI_UPLOAD_PROTOCOL_ERROR", "上传结果缺少文件名称", true))?
        .to_string();
    let file_uri = value
        .pointer("/file/uri")
        .and_then(Value::as_str)
        .ok_or_else(|| error("AI_UPLOAD_PROTOCOL_ERROR", "上传结果缺少文件地址", true))?
        .to_string();

    let status_url = api_url(&settings.base_url, &format!("/v1beta/{file_name}"));
    for _ in 0..180 {
        let response = client
            .get(&status_url)
            .header("x-goog-api-key", api_key)
            .send()
            .await
            .map_err(|e| {
                error(
                    "AI_FILE_STATUS_ERROR",
                    format!("无法查询视频处理状态：{e}"),
                    true,
                )
            })?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| {
            error(
                "AI_FILE_STATUS_ERROR",
                format!("无法读取视频处理状态：{e}"),
                true,
            )
        })?;
        if !status.is_success() {
            return Err(response_error(status, &value));
        }
        match value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("PROCESSING")
        {
            "ACTIVE" => return Ok((file_name, file_uri)),
            "FAILED" => {
                return Err(error(
                    "AI_VIDEO_PROCESSING_FAILED",
                    "大模型平台处理视频失败",
                    true,
                ))
            }
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
    Err(error(
        "AI_VIDEO_PROCESSING_TIMEOUT",
        "等待大模型平台处理视频超时",
        true,
    ))
}

async fn delete_uploaded_file(
    client: &Client,
    settings: &AiSettingsFile,
    api_key: &str,
    file_name: &str,
) {
    let url = api_url(&settings.base_url, &format!("/v1beta/{file_name}"));
    let _ = client
        .delete(url)
        .header("x-goog-api-key", api_key)
        .send()
        .await;
}

#[tauri::command]
pub async fn analyze_video(
    app: tauri::AppHandle,
    input: VideoUnderstandingInput,
) -> Result<VideoUnderstandingResult, String> {
    analyze_video_path(&app, Path::new(&input.video_path), &input.prompt).await
}

pub(crate) async fn analyze_video_path(
    app: &tauri::AppHandle,
    path: &Path,
    prompt: &str,
) -> Result<VideoUnderstandingResult, String> {
    if prompt.trim().chars().count() < 10 { return Err(error("VIDEO_PROMPT_REQUIRED", "请输入至少10个字符的视频分析提示词", false)); }
    let metadata = tokio::fs::metadata(path).await.map_err(|e| error("VIDEO_READ_ERROR", e.to_string(), false))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_VIDEO_SIZE || mime_type(path).is_none() {
        return Err(error("VIDEO_FILE_INVALID", "视频为空、格式不支持或超过2GB", false));
    }
    let directory = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("video-understanding-temp");
    tokio::fs::create_dir_all(&directory).await.map_err(|e| e.to_string())?;
    let compressed = directory.join(format!("{}-platform.mp4", uuid::Uuid::new_v4()));
    let source = path.to_owned();
    let destination = compressed.clone();
    let compression = tauri::async_runtime::spawn_blocking(move || {
        crate::media_tools::compress_video_for_inline_analysis(&source, &destination, LINGKE_INLINE_TARGET)
    }).await.map_err(|e| e.to_string())?;
    if let Err(e) = compression {
        let _ = tokio::fs::remove_file(&compressed).await;
        return Err(e);
    }
    let result = crate::platform_video_understanding::understand_uploaded_file(
        None, &compressed, prompt,
        path.file_name().and_then(|v| v.to_str()).unwrap_or("video").to_owned(), metadata.len()
    ).await;
    let _ = tokio::fs::remove_file(&compressed).await;
    result
}

fn image_mime(bytes: &[u8], fallback: Option<&str>) -> String {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png".into()
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg".into()
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp".into()
    } else {
        fallback
            .filter(|value| value.starts_with("image/"))
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string()
    }
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn decode_image_base64(value: &str, mime_hint: Option<&str>) -> Result<ImageBytes, String> {
    let (mime, encoded) = if let Some(rest) = value.strip_prefix("data:") {
        let (metadata, encoded) = rest.split_once(',').ok_or_else(|| {
            error(
                "AI_IMAGE_RESPONSE_INVALID",
                "生图接口返回了无效的 Data URL",
                true,
            )
        })?;
        (metadata.split(';').next().or(mime_hint), encoded)
    } else {
        (mime_hint, value)
    };
    let bytes = BASE64.decode(encoded.trim()).map_err(|e| {
        error(
            "AI_IMAGE_RESPONSE_INVALID",
            format!("无法解码生图接口返回的图片：{e}"),
            true,
        )
    })?;
    if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 {
        return Err(error(
            "AI_IMAGE_RESPONSE_INVALID",
            "生图接口返回的图片为空或超过 40MB",
            true,
        ));
    }
    let mime_type = image_mime(&bytes, mime);
    Ok(ImageBytes { bytes, mime_type })
}

fn validate_remote_image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value)
        .map_err(|_| error("AI_IMAGE_URL_INVALID", "生图接口返回了无效图片地址", true))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(error(
            "AI_IMAGE_URL_INVALID",
            "生图接口返回的图片地址不是 HTTP(S) 地址",
            true,
        ));
    }
    let host = url.host_str().unwrap_or_default();
    if host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
    {
        return Err(error(
            "AI_IMAGE_URL_INVALID",
            "生图接口返回了不安全的本机图片地址",
            false,
        ));
    }
    Ok(url)
}

async fn download_generated_image(client: &Client, value: &str) -> Result<ImageBytes, String> {
    let url = validate_remote_image_url(value)?;
    let response = client.get(url).send().await.map_err(|e| {
        error(
            "AI_IMAGE_DOWNLOAD_ERROR",
            format!("无法下载生成图片：{e}"),
            true,
        )
    })?;
    if !response.status().is_success() {
        return Err(error(
            "AI_IMAGE_DOWNLOAD_ERROR",
            format!("下载生成图片失败（{}）", response.status().as_u16()),
            true,
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > 40 * 1024 * 1024)
    {
        return Err(error("AI_IMAGE_DOWNLOAD_ERROR", "生成图片超过 40MB", false));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| error("AI_IMAGE_DOWNLOAD_ERROR", e.to_string(), true))?
        .to_vec();
    if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 {
        return Err(error(
            "AI_IMAGE_DOWNLOAD_ERROR",
            "下载的生成图片为空或超过 40MB",
            false,
        ));
    }
    let mime_type = image_mime(&bytes, content_type.as_deref());
    Ok(ImageBytes { bytes, mime_type })
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| {
        error(
            "AI_IMAGE_RESPONSE_INVALID",
            format!("生图接口返回的内容不是有效 JSON：{e}"),
            true,
        )
    })?;
    if !status.is_success() {
        return Err(response_error(status, &value));
    }
    Ok(value)
}

async fn openai_generate_image(
    client: &Client,
    base_url: &str,
    model: &str,
    api_key: &str,
    prompt: &str,
    aspect_ratio: &str,
    references: &[ReferenceImage],
) -> Result<ImageBytes, String> {
    let endpoint = if references.is_empty() {
        openai_api_url(base_url, "/v1/images/generations")
    } else {
        openai_api_url(base_url, "/v1/images/edits")
    };
    let size = if aspect_ratio == "16:9" {
        "1536x1024"
    } else {
        "1024x1536"
    };
    crate::logging::debug(
        "ai.image.request",
        json!({
            "endpoint": endpoint,
            "protocol": "openai",
            "authentication": "Bearer [REDACTED]",
            "parameters": {
                "model": model,
                "prompt": prompt,
                "size": size,
                "aspect_ratio": aspect_ratio,
                "references": reference_log_details(references),
                "body_format": if references.is_empty() { "application/json" } else { "multipart/form-data" },
            }
        }),
    );
    let request = if references.is_empty() {
        client
            .post(&endpoint)
            .bearer_auth(api_key)
            .json(&json!({"model": model, "prompt": prompt, "size": size}))
    } else {
        let mut form = multipart::Form::new()
            .text("model", model.to_owned())
            .text("prompt", prompt.to_owned())
            .text("size", size.to_owned());
        for reference in references {
            let part = multipart::Part::bytes(reference.bytes.clone())
                .file_name(reference.filename.clone())
                .mime_str(&reference.mime_type)
                .map_err(|e| error("AI_IMAGE_REFERENCE_INVALID", e.to_string(), false))?;
            form = form.part("image[]", part);
        }
        client.post(&endpoint).bearer_auth(api_key).multipart(form)
    };
    let response = request.send().await.map_err(|e| {
        crate::logging::error(
            "ai.image.request_failed",
            json!({"endpoint": endpoint, "protocol": "openai", "model": model, "error": e.to_string()}),
        );
        error(
            "AI_IMAGE_NETWORK_ERROR",
            format!("无法连接生图接口：{e}"),
            true,
        )
    })?;
    let value = response_json(response).await?;
    if let Some(encoded) = value.pointer("/data/0/b64_json").and_then(Value::as_str) {
        return decode_image_base64(encoded, None);
    }
    if let Some(url) = value.pointer("/data/0/url").and_then(Value::as_str) {
        if url.starts_with("data:image/") {
            return decode_image_base64(url, None);
        }
        return download_generated_image(client, url).await;
    }
    Err(error(
        "AI_IMAGE_RESPONSE_INVALID",
        "OpenAI 兼容生图响应缺少 data[0].b64_json 或 data[0].url",
        true,
    ))
}

async fn gemini_generate_image(
    client: &Client,
    base_url: &str,
    model: &str,
    api_key: &str,
    prompt: &str,
    aspect_ratio: &str,
    references: &[ReferenceImage],
) -> Result<ImageBytes, String> {
    let url = api_url(base_url, &format!("/v1beta/models/{model}:generateContent"));
    let mut request_parts = vec![json!({"text": prompt})];
    for reference in references {
        request_parts
            .push(json!({"text": format!("参考图：{}（{}）", reference.label, reference.kind)}));
        request_parts.push(json!({"inlineData": {"mimeType": reference.mime_type, "data": BASE64.encode(&reference.bytes)}}));
    }
    crate::logging::debug(
        "ai.image.request",
        json!({
            "endpoint": url,
            "protocol": "gemini",
            "authentication": "x-goog-api-key/Bearer [REDACTED]",
            "parameters": {
                "model": model,
                "contents": [{"role": "user", "parts": [{"text": prompt}, {"references": reference_log_details(references)}]}],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"],
                    "imageConfig": {"aspectRatio": aspect_ratio}
                }
            }
        }),
    );
    let response = client
        .post(&url)
        .header("x-goog-api-key", api_key)
        .bearer_auth(api_key)
        .json(&json!({
            "contents": [{"role": "user", "parts": request_parts}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {"aspectRatio": aspect_ratio}
            }
        }))
        .send()
        .await
        .map_err(|e| {
            crate::logging::error(
                "ai.image.request_failed",
                json!({"endpoint": url, "protocol": "gemini", "model": model, "error": e.to_string()}),
            );
            error(
                "AI_IMAGE_NETWORK_ERROR",
                format!("无法连接生图接口：{e}"),
                true,
            )
        })?;
    let value = response_json(response).await?;
    let parts = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "AI_IMAGE_RESPONSE_INVALID",
                "Gemini 生图响应缺少图片内容",
                true,
            )
        })?;
    for part in parts {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        if let Some(encoded) = inline
            .and_then(|value| value.get("data"))
            .and_then(Value::as_str)
        {
            let mime = inline
                .and_then(|value| value.get("mimeType").or_else(|| value.get("mime_type")))
                .and_then(Value::as_str);
            return decode_image_base64(encoded, mime);
        }
    }
    Err(error(
        "AI_IMAGE_RESPONSE_INVALID",
        "Gemini 生图响应没有返回 inlineData 图片",
        true,
    ))
}

fn media_task_id(value: &Value) -> Option<String> {
    ["/data/task_id", "/task_id"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_u64().map(|id| id.to_string()))
        })
        .or_else(|| {
            ["/data/task_ids/0", "/data/任务ids/0", "/data/tasks/0/id"]
                .into_iter()
                .find_map(|pointer| value.pointer(pointer))
                .and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.as_u64().map(|id| id.to_string()))
                })
        })
}

fn media_application_error(value: &Value) -> Option<String> {
    let code = value.get("code").and_then(Value::as_i64)?;
    if matches!(code, 0 | 200) {
        return None;
    }
    Some(
        value
            .get("msg")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("媒体生图接口返回失败")
            .to_string(),
    )
}

async fn media_create_image(
    client: &Client,
    base_url: &str,
    model: &str,
    api_key: &str,
    prompt: &str,
    aspect_ratio: &str,
    references: &[ReferenceImage],
) -> Result<MediaCreateResult, String> {
    let images = references
        .iter()
        .map(|reference| {
            json!({
                "url": reference.data_url, "label": reference.label, "type": reference.kind,
            })
        })
        .collect::<Vec<_>>();
    let endpoint = api_url(base_url, "/v1/media/generate");
    crate::logging::debug(
        "ai.image.request",
        json!({
            "endpoint": endpoint,
            "protocol": "media",
            "authentication": "Bearer [REDACTED]",
            "parameters": {
                "model": model,
                "prompt": prompt,
                "images": reference_log_details(references),
                "params": {
                    "aspect_ratio": aspect_ratio,
                    "reference_images": reference_log_details(references),
                }
            }
        }),
    );
    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "prompt": prompt,
            "images": images.clone(),
            "params": {"aspect_ratio": aspect_ratio, "reference_images": images}
        }))
        .send()
        .await
        .map_err(|e| {
            crate::logging::error(
                "ai.image.request_failed",
                json!({"endpoint": endpoint, "protocol": "media", "model": model, "error": e.to_string()}),
            );
            error(
                "AI_IMAGE_NETWORK_ERROR",
                format!("无法创建生图任务：{e}"),
                true,
            )
        })?;
    let created = response_json(response).await?;
    if let Some(message) = media_application_error(&created) {
        return Err(error("AI_IMAGE_GENERATION_FAILED", message, true));
    }
    if let Some(url) = created
        .pointer("/data/result_url")
        .or_else(|| created.get("result_url"))
        .and_then(Value::as_str)
    {
        return download_generated_image(client, url)
            .await
            .map(MediaCreateResult::Image);
    }
    let task_id = media_task_id(&created).ok_or_else(|| {
        error(
            "AI_IMAGE_RESPONSE_INVALID",
            "媒体生图接口没有返回 task_id",
            true,
        )
    })?;
    Ok(MediaCreateResult::Task(task_id))
}

async fn media_poll_image(
    client: &Client,
    base_url: &str,
    api_key: &str,
    task_id: &str,
) -> Result<ImageBytes, String> {
    let status_url = api_url(base_url, &format!("/v1/media/status?task_id={task_id}"));
    for _ in 0..90 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = client
            .get(&status_url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| {
                error(
                    "AI_IMAGE_STATUS_ERROR",
                    format!("无法查询生图任务：{e}"),
                    true,
                )
            })?;
        let status = response_json(response).await?;
        if let Some(message) = media_application_error(&status) {
            return Err(error("AI_IMAGE_STATUS_ERROR", message, true));
        }
        let data = status.get("data").unwrap_or(&status);
        let state = data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("running");
        let is_final = data
            .get("is_final")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if state == "success" || (is_final && state != "failed") {
            let url = data
                .get("result_url")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        "AI_IMAGE_RESPONSE_INVALID",
                        "生图任务完成但缺少 result_url",
                        true,
                    )
                })?;
            return download_generated_image(client, url).await;
        }
        if state == "failed" || is_final {
            let message = data
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("生图任务失败");
            return Err(error("AI_IMAGE_GENERATION_FAILED", message, true));
        }
    }
    Err(error("AI_IMAGE_TIMEOUT", "等待生图任务完成超时", true))
}

fn validate_project_image_target(
    input: &GenerateProjectImageInput,
) -> Result<(PathBuf, PathBuf), String> {
    let project_root = PathBuf::from(&input.project_path);
    if !project_root.join("project.json").is_file() || !project_root.join("project.db").is_file() {
        return Err(error("PROJECT_INVALID", "项目目录无效", false));
    }
    if !matches!(input.target_type.as_str(), "character" | "scene")
        || input.target_id.is_empty()
        || !input
            .target_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(error("AI_IMAGE_TARGET_INVALID", "生图目标无效", false));
    }
    let relative_dir = if input.target_type == "character" {
        "characters"
    } else {
        "scenes"
    };
    Ok((project_root, PathBuf::from(relative_dir)))
}

#[tauri::command]
pub async fn generate_project_image(
    app: tauri::AppHandle,
    input: GenerateProjectImageInput,
) -> Result<GeneratedProjectImage, String> {
    let (project_root, relative_dir) = validate_project_image_target(&input)?;
    let prompt = input.prompt.trim();
    if !(10..=20_000).contains(&prompt.chars().count()) {
        return Err(error(
            "AI_IMAGE_PROMPT_INVALID",
            "生图提示词长度必须在 10 到 20000 个字符之间",
            false,
        ));
    }
    let settings = load_file(&app)?;
    let api_key = load_api_key()?.ok_or_else(|| error("AI_API_KEY_REQUIRED", "请先在系统设置中保存 API Key", false))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()
        .map_err(|e| error("AI_CLIENT_ERROR", e.to_string(), false))?;
    let protocol = settings.image_protocol.as_str();
    let image = match protocol {
        "openai" => {
            openai_generate_image(
                &client,
                &settings.base_url,
                &settings.image_model,
                &api_key,
                prompt,
                &input.aspect_ratio,
                &[],
            )
            .await?
        }
        "gemini" => {
            gemini_generate_image(
                &client,
                &settings.base_url,
                &settings.image_model,
                &api_key,
                prompt,
                &input.aspect_ratio,
                &[],
            )
            .await?
        }
        "media" => {
            match media_create_image(
                &client,
                &settings.base_url,
                &settings.image_model,
                &api_key,
                prompt,
                &input.aspect_ratio,
                &[],
            )
            .await?
            {
                MediaCreateResult::Image(image) => image,
                MediaCreateResult::Task(task_id) => {
                    media_poll_image(&client, &settings.base_url, &api_key, &task_id).await?
                }
            }
        }
        _ => {
            return Err(error(
                "AI_IMAGE_PROTOCOL_INVALID",
                "当前生图协议无效",
                false,
            ))
        }
    };
    let target_dir = project_root.join(&relative_dir);
    fs::create_dir_all(&target_dir)
        .map_err(|e| error("AI_IMAGE_WRITE_ERROR", e.to_string(), true))?;
    let extension = image_extension(&image.mime_type);
    let filename = format!(
        "{}_{}.{}",
        input.target_id,
        chrono::Utc::now().timestamp_millis(),
        extension
    );
    let absolute_path = target_dir.join(filename);
    fs::write(&absolute_path, &image.bytes)
        .map_err(|e| error("AI_IMAGE_WRITE_ERROR", e.to_string(), true))?;
    let relative_path = relative_dir.join(absolute_path.file_name().unwrap_or_default());
    let source_key = format!(
        "{}/direct/{}",
        project_root.to_string_lossy(),
        relative_path.to_string_lossy()
    );
    crate::database::asset_library::store_generated(
        &app,
        &project_root,
        &source_key,
        &input.target_type,
        &input.target_id,
        prompt,
        &absolute_path,
    )?;
    Ok(GeneratedProjectImage {
        relative_path: relative_path.to_string_lossy().replace('\\', "/"),
        absolute_path: absolute_path.to_string_lossy().to_string(),
        model: settings.image_model,
        protocol: settings.image_protocol,
        prompt: prompt.to_string(),
        preview_data_url: format!(
            "data:{};base64,{}",
            image.mime_type,
            BASE64.encode(&image.bytes)
        ),
    })
}

fn validate_image_task_item(item: &CreateImageGenerationTaskItem) -> Result<(), String> {
    if !matches!(
        item.target_type.as_str(),
        "character" | "character_state" | "scene" | "shot"
    ) || item.target_id.is_empty()
        || !item
            .target_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(error("AI_IMAGE_TARGET_INVALID", "生图目标无效", false));
    }
    if !(10..=20_000).contains(&item.prompt.trim().chars().count()) {
        return Err(error(
            "AI_IMAGE_PROMPT_INVALID",
            "生图提示词长度必须在 10 到 20000 个字符之间",
            false,
        ));
    }
    if !matches!(item.aspect_ratio.as_str(), "9:16" | "16:9") {
        return Err(error(
            "AI_IMAGE_ASPECT_RATIO_INVALID",
            "画面比例必须是 9:16 或 16:9",
            false,
        ));
    }
    Ok(())
}

fn validate_project_root(project_path: &str) -> Result<PathBuf, String> {
    let project_root = PathBuf::from(project_path);
    if !project_root.join("project.json").is_file() || !project_root.join("project.db").is_file() {
        return Err(error("PROJECT_INVALID", "项目目录无效", false));
    }
    Ok(project_root)
}

fn reference_inputs(value: Option<&Value>) -> Vec<GenerationReferenceAssetInput> {
    value
        .and_then(|metadata| metadata.get("reference_assets"))
        .cloned()
        .and_then(|assets| serde_json::from_value(assets).ok())
        .unwrap_or_default()
}

fn load_reference_images(
    project_root: &Path,
    inputs: &[GenerationReferenceAssetInput],
) -> Result<Vec<ReferenceImage>, String> {
    if inputs.len() > 12 {
        return Err(error(
            "AI_REFERENCE_COUNT_INVALID",
            "一次最多使用 12 张参考图",
            false,
        ));
    }
    let canonical_root = fs::canonicalize(project_root)
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    let mut total_size = 0_u64;
    let mut images = Vec::with_capacity(inputs.len());
    for input in inputs {
        if input.label.trim().is_empty()
            || !matches!(
                input.kind.as_str(),
                "scene" | "character" | "shot_first_frame" | "shot_reference"
            )
        {
            return Err(error("AI_REFERENCE_INVALID", "参考图标签或类型无效", false));
        }
        let relative = PathBuf::from(&input.relative_path);
        if relative.is_absolute() {
            return Err(error(
                "AI_REFERENCE_INVALID",
                "参考图必须位于当前项目目录",
                false,
            ));
        }
        let absolute = fs::canonicalize(canonical_root.join(&relative)).map_err(|e| {
            error(
                "AI_REFERENCE_READ_ERROR",
                format!("无法读取参考图 {}：{e}", input.label),
                false,
            )
        })?;
        if !absolute.starts_with(&canonical_root) || !absolute.is_file() {
            return Err(error(
                "AI_REFERENCE_INVALID",
                "参考图路径超出项目目录",
                false,
            ));
        }
        let bytes = fs::read(&absolute)
            .map_err(|e| error("AI_REFERENCE_READ_ERROR", e.to_string(), true))?;
        total_size += bytes.len() as u64;
        if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 || total_size > 80 * 1024 * 1024 {
            return Err(error(
                "AI_REFERENCE_TOO_LARGE",
                "参考图为空、单图超过 40MB 或总大小超过 80MB",
                false,
            ));
        }
        let mime_type = image_mime(&bytes, None);
        let extension = image_extension(&mime_type);
        let filename = format!("{}_reference.{extension}", input.kind);
        let data_url = format!("data:{mime_type};base64,{}", BASE64.encode(&bytes));
        images.push(ReferenceImage {
            label: input.label.clone(),
            kind: input.kind.clone(),
            filename,
            bytes,
            mime_type,
            data_url,
        });
    }
    Ok(images)
}

fn spawn_image_task(app: tauri::AppHandle, project_root: PathBuf, task_id: String) {
    let should_spawn = active_image_tasks()
        .lock()
        .map(|mut active| active.insert(task_id.clone()))
        .unwrap_or(false);
    if !should_spawn {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let permit = image_task_limiter().acquire_owned().await;
        let result = match permit {
            Ok(_permit) => execute_image_task(&app, &project_root, &task_id).await,
            Err(error) => Err(format!("生图并发队列不可用：{error}")),
        };
        if let Err(message) = result {
            crate::logging::error(
                "ai.image.task_failed",
                json!({"project_path": project_root, "task_id": task_id, "error": message}),
            );
            persist_image_failure(&project_root, &task_id, &message).await;
        }
        if let Ok(mut active) = active_image_tasks().lock() {
            active.remove(&task_id);
        }
    });
}

async fn persist_image_failure(project_root: &Path, task_id: &str, message: &str) {
    for _ in 0..3 {
        let result = (|| {
            let connection = crate::database::open(project_root)?;
            let record = crate::database::generation_records::get(&connection, task_id)?;
            let message = if let Some(record) = record {
                if let Some(grant) = record.result.as_ref().and_then(|v| v.get("workflow_credit_id")).and_then(Value::as_str) {
                    crate::workflow_credit::failure_message(project_root, grant, &format!("image:{}:{}", record.target_type, record.target_id), task_id, message)
                } else { message.to_owned() }
            } else { message.to_owned() };
            crate::database::image_tasks::fail(&connection, task_id, &message)
        })();
        match result {
            Ok(()) => return,
            Err(persistence_error) => crate::logging::error("ai.image.failure_state_retry", json!({"task_id":task_id,"error":persistence_error})),
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    crate::logging::critical("ai.image.failure_state_not_saved", json!({"project_path":project_root,"task_id":task_id,"error":message}));
    if let Ok(mut failures) = unsaved_image_failures().lock() {
        failures.insert(task_id.to_owned(), crate::workflow_credit::error("任务已停止，但状态暂时无法保存。不会重新提交或重复扣分，请检查本地存储。"));
    }
}

async fn execute_image_task(
    app: &tauri::AppHandle,
    project_root: &Path,
    task_id: &str,
) -> Result<(), String> {
    let connection = crate::database::open(project_root)?;
    let task = crate::database::image_tasks::get(&connection, task_id)?
        .ok_or_else(|| format!("找不到生图任务：{task_id}"))?;
    let generation_record = crate::database::generation_records::get(&connection, task_id)?;
    let reference_assets = reference_inputs(
        generation_record
            .as_ref()
            .and_then(|record| record.result.as_ref()),
    );
    if task.status == crate::database::image_tasks::STATUS_COMPLETED {
        return Ok(());
    }
    if task.status == crate::database::image_tasks::STATUS_FAILED {
        let base = crate::platform_media::api_base_url(&task.base_url)?;
        let cached = crate::workflow_credit::receipt(project_root, task_id, &base)?;
        if !cached.is_some_and(|r| r.response.is_some()) { return Ok(()); }
    }
    if !matches!(
        task.target_type.as_str(),
        "character" | "character_state" | "scene" | "shot"
    ) || task.target_id.is_empty()
        || !task
            .target_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(error("AI_IMAGE_TARGET_INVALID", "生图任务目标无效", false));
    }
    crate::database::image_tasks::mark_running(&connection, task_id)?;
    drop(connection);
    let references = load_reference_images(project_root, &reference_assets)?;

    if task.protocol != "platform" { return Err(error("PLATFORM_MEDIA_MODEL_REQUIRED", "旧版生图方式已停用，请重新选择生成方案，确认积分后再开始", false)); }
    let api_key = String::new();
    let client = Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()
        .map_err(|e| error("AI_CLIENT_ERROR", e.to_string(), false))?;
    let prompt = task.prompt.trim();
    let image = match task.protocol.as_str() {
        "platform" => {
            let metadata = generation_record.as_ref().and_then(|record| record.result.as_ref()).cloned().unwrap_or_else(|| json!({}));
            let provider_model_id = metadata.get("provider_model_id").and_then(Value::as_str).ok_or_else(|| error("PLATFORM_MEDIA_MODEL_REQUIRED", "生图任务缺少服务端模型编号", false))?;
            let resolution = metadata.get("resolution").and_then(Value::as_str).ok_or_else(|| error("PLATFORM_MEDIA_RESOLUTION_REQUIRED", "生图任务缺少分辨率", false))?;
            let reference_images = references.iter().map(|reference| json!({"data_url": reference.data_url, "label": reference.label, "type": reference.kind})).collect::<Vec<_>>();
            let operation = format!("{} · {}", match task.target_type.as_str() { "character" | "character_state" => "角色图生成", "scene" => "场景图生成", _ => "分镜图生成" }, task.target_id);
            let value = crate::platform_media::generate(&task.base_url, provider_model_id, task_id, json!({
                "prompt": prompt, "aspect_ratio": task.aspect_ratio, "resolution": resolution,
                "reference_images": reference_images,
                "params": {"aspect_ratio": task.aspect_ratio, "resolution": resolution, "reference_images": reference_images}
            }), &operation, metadata.get("workflow_credit_id").and_then(Value::as_str).map(|id| (project_root, id, format!("image:{}:{}", task.target_type, task.target_id)))).await?;
            platform_image_result(&client, &value).await?
        }
        "openai" => {
            openai_generate_image(
                &client,
                &task.base_url,
                &task.model,
                &api_key,
                prompt,
                &task.aspect_ratio,
                &references,
            )
            .await?
        }
        "gemini" => {
            gemini_generate_image(
                &client,
                &task.base_url,
                &task.model,
                &api_key,
                prompt,
                &task.aspect_ratio,
                &references,
            )
            .await?
        }
        "media" => {
            let remote_task_id = if let Some(remote_task_id) = task.remote_task_id.clone() {
                let connection = crate::database::open(project_root)?;
                crate::database::image_tasks::mark_remote_processing(
                    &connection,
                    task_id,
                    &remote_task_id,
                )?;
                remote_task_id
            } else {
                match media_create_image(
                    &client,
                    &task.base_url,
                    &task.model,
                    &api_key,
                    prompt,
                    &task.aspect_ratio,
                    &references,
                )
                .await?
                {
                    MediaCreateResult::Image(image) => {
                        return persist_image_result(app, project_root, &task, &image).await;
                    }
                    MediaCreateResult::Task(remote_task_id) => {
                        let connection = crate::database::open(project_root)?;
                        crate::database::image_tasks::mark_remote_processing(
                            &connection,
                            task_id,
                            &remote_task_id,
                        )?;
                        remote_task_id
                    }
                }
            };
            media_poll_image(&client, &task.base_url, &api_key, &remote_task_id).await?
        }
        _ => {
            return Err(error(
                "AI_IMAGE_PROTOCOL_INVALID",
                "当前生图协议无效",
                false,
            ))
        }
    };
    // Retry local persistence with the same bytes; never call generation again.
    let mut last_error = String::new();
    for _ in 0..3 {
        match persist_image_result(app, project_root, &task, &image).await {
            Ok(()) => return Ok(()),
            Err(message) => last_error = message,
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(last_error)
}

async fn persist_image_result(
    app: &tauri::AppHandle,
    project_root: &Path,
    task: &crate::database::image_tasks::ImageGenerationTask,
    image: &ImageBytes,
) -> Result<(), String> {
    let connection = crate::database::open(project_root)?;
    crate::database::image_tasks::mark_downloading(&connection, &task.id)?;
    drop(connection);

    let relative_dir = if task.target_type == "character" {
        PathBuf::from("characters")
    } else if task.target_type == "character_state" {
        PathBuf::from("characters/states")
    } else if task.target_type == "scene" {
        PathBuf::from("scenes")
    } else if task.target_type == "shot" {
        PathBuf::from("shots/images")
    } else {
        return Err(error("AI_IMAGE_TARGET_INVALID", "生图目标无效", false));
    };
    let target_dir = project_root.join(&relative_dir);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| error("AI_IMAGE_WRITE_ERROR", e.to_string(), true))?;
    let extension = image_extension(&image.mime_type);
    let filename = format!(
        "{}_{}.{}",
        task.target_id,
        task.id,
        extension
    );
    let absolute_path = target_dir.join(filename);
    tokio::fs::write(&absolute_path, &image.bytes)
        .await
        .map_err(|e| error("AI_IMAGE_WRITE_ERROR", e.to_string(), true))?;
    let relative_path = relative_dir
        .join(absolute_path.file_name().unwrap_or_default())
        .to_string_lossy()
        .replace('\\', "/");
    let source_key = format!("task:{}/{}", task.project_id, task.id);
    crate::database::asset_library::store_generated(
        app,
        project_root,
        &source_key,
        &task.target_type,
        &task.target_id,
        &task.prompt,
        &absolute_path,
    )?;
    let mut connection = crate::database::open(project_root)?;
    crate::database::image_tasks::complete(
        &mut connection,
        &task.id,
        &relative_path,
        &absolute_path.to_string_lossy(),
        &image.mime_type,
    )
}

#[tauri::command]
pub fn create_image_generation_tasks(
    app: tauri::AppHandle,
    input: CreateImageGenerationTasksInput,
) -> Result<Vec<crate::database::image_tasks::ImageGenerationTask>, String> {
    let project_root = validate_project_root(&input.project_path)?;
    if input.tasks.is_empty() || input.tasks.len() > 100 {
        return Err(error(
            "AI_IMAGE_TASK_COUNT_INVALID",
            "一次生图任务数量必须在 1 到 100 之间",
            false,
        ));
    }
    for item in &input.tasks {
        validate_image_task_item(item)?;
        load_reference_images(&project_root, &item.reference_assets)?;
    }
    if input.provider_model_id.trim().is_empty() || input.model_alias.trim().is_empty() || input.resolution.trim().is_empty() {
        return Err(error("PLATFORM_MEDIA_MODEL_REQUIRED", "请选择服务端生图模型和分辨率", false));
    }
    let connection = crate::database::open(&project_root)?;
    let actual_project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    if actual_project_id != input.project_id {
        return Err(error("PROJECT_INVALID", "项目编号与项目目录不匹配", false));
    }
    let mut created = Vec::with_capacity(input.tasks.len());
    for item in input.tasks {
        if crate::database::image_tasks::has_unfinished_target(
            &connection,
            &input.project_id,
            &item.target_type,
            &item.target_id,
        )? {
            continue;
        }
        let task = crate::database::image_tasks::create(
            &connection,
            crate::database::image_tasks::NewImageGenerationTask {
                project_id: &input.project_id,
                target_type: &item.target_type,
                target_id: &item.target_id,
                base_url: &input.platform_api_base_url,
                model: &input.model_alias,
                protocol: "platform",
                prompt: item.prompt.trim(),
                aspect_ratio: &item.aspect_ratio,
            },
        )?;
        crate::database::generation_records::set_request_metadata(
            &connection,
            &task.id,
            &json!({"reference_assets": item.reference_assets, "provider_model_id": input.provider_model_id, "resolution": input.resolution, "workflow_credit_id": input.workflow_credit_id}),
        )?;
        created.push(task);
    }
    drop(connection);
    for task in &created {
        spawn_image_task(app.clone(), project_root.clone(), task.id.clone());
    }
    Ok(created)
}

#[tauri::command]
pub async fn list_image_generation_tasks(
    project_path: String,
) -> Result<Vec<crate::database::image_tasks::ImageGenerationTask>, String> {
    crate::background::run("读取图片生成任务", move || {
        let project_root = validate_project_root(&project_path)?;
        let connection = crate::database::open(&project_root)?;
        let project_id: String = connection
            .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
            .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
        let mut tasks = crate::database::image_tasks::list_for_project(&connection, &project_id)?;
        // Never leave a dead worker looking RUNNING if its error write failed.
        if let Ok(mut failures) = unsaved_image_failures().lock() {
            for task in &mut tasks {
                if let Some(message) = failures.get(&task.id).cloned() {
                    if task.status == crate::database::image_tasks::STATUS_COMPLETED { failures.remove(&task.id); continue; }
                    if crate::database::image_tasks::fail(&connection, &task.id, &message).is_ok() { failures.remove(&task.id); }
                    task.status = crate::database::image_tasks::STATUS_FAILED.to_owned();
                    task.error = serde_json::from_str(&message).ok();
                    task.updated_at = Utc::now().to_rfc3339();
                }
            }
        }
        Ok(tasks)
    })
    .await
}

#[tauri::command]
pub async fn resume_image_generation_tasks(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<Vec<crate::database::image_tasks::ImageGenerationTask>, String> {
    crate::background::run("初始化图片生成任务", move || {
        let project_root = validate_project_root(&project_path)?;
        resume_project_image_tasks(&app, &project_root)
    })
    .await
}

pub(crate) fn resume_project_image_tasks(
    app: &tauri::AppHandle,
    project_root: &Path,
) -> Result<Vec<crate::database::image_tasks::ImageGenerationTask>, String> {
    let connection = crate::database::open(project_root)?;
    let mut tasks = crate::database::image_tasks::list_unfinished(&connection)?;
    // A completed provider response can be saved again without new generation,
    // even if the original workflow was stopped after a local storage error.
    for id in crate::workflow_credit::recoverable_images(project_root)? {
        if let Some(task) = crate::database::image_tasks::get(&connection, &id)? { tasks.push(task); }
    }
    for task in &tasks {
        if let Some(message) = unsaved_image_failures().lock().ok().and_then(|failures| failures.get(&task.id).cloned()) {
            crate::database::image_tasks::fail(&connection, &task.id, &message)?;
            continue;
        }
        spawn_image_task(app.clone(), project_root.to_path_buf(), task.id.clone());
    }
    Ok(tasks)
}

fn media_result_url(value: &Value) -> Option<String> {
    [
        "/data/result_url",
        "/result_url",
        "/data/video_url",
        "/video_url",
        "/data/url",
        "/url",
        "/data/output/url",
        "/output/url",
        "/data/outputs/0/url",
        "/outputs/0/url",
    ]
    .into_iter()
    .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .map(str::to_owned)
}

fn find_media_value<'a>(value: &'a Value, keys: &[&str], depth: usize) -> Option<&'a str> {
    if depth > 7 { return None; }
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(found) = map.get(*key).and_then(Value::as_str).filter(|item| !item.trim().is_empty()) { return Some(found); }
            }
            map.values().find_map(|child| find_media_value(child, keys, depth + 1))
        }
        Value::Array(items) => items.iter().find_map(|child| find_media_value(child, keys, depth + 1)),
        _ => None,
    }
}

async fn platform_image_result(client: &Client, value: &Value) -> Result<ImageBytes, String> {
    if let Some(encoded) = find_media_value(value, &["b64_json", "base64", "data"], 0) {
        if encoded.starts_with("data:image/") || BASE64.decode(encoded.trim()).is_ok() {
            return decode_image_base64(encoded, None);
        }
    }
    if let Some(url) = find_media_value(value, &["result_url", "image_url", "url"], 0) {
        if url.starts_with("data:image/") { return decode_image_base64(url, None); }
        return download_generated_image(client, url).await;
    }
    Err(error("AI_IMAGE_RESPONSE_INVALID", "服务端生图结果中没有找到图片", true))
}

fn append_generation_log(project_root: &Path, event: &str, details: Value) {
    let log_dir = project_root.join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("ai-generation.log"))
    else {
        return;
    };
    let entry = json!({
        "timestamp": Utc::now().to_rfc3339(),
        "event": event,
        "details": details,
    });
    let _ = writeln!(file, "{entry}");
}

fn reqwest_error_detail(request_error: &reqwest::Error) -> String {
    let category = if request_error.is_timeout() {
        "请求超时"
    } else if request_error.is_connect() {
        "连接失败"
    } else if request_error.is_body() {
        "发送请求体失败"
    } else if request_error.is_decode() {
        "响应解码失败"
    } else {
        "网络请求失败"
    };
    let mut causes = vec![request_error.to_string()];
    let mut source = StdError::source(request_error);
    while let Some(cause) = source {
        let message = cause.to_string();
        if !message.is_empty() && causes.last() != Some(&message) {
            causes.push(message);
        }
        source = cause.source();
    }
    format!("{category}：{}", causes.join(" -> "))
}

fn response_excerpt(body: &str) -> String {
    let excerpt = body.chars().take(4_000).collect::<String>();
    if body.chars().count() > 4_000 {
        format!("{excerpt}…（响应已截断）")
    } else {
        excerpt
    }
}

fn ordered_video_references(references: &[ReferenceImage]) -> Vec<&ReferenceImage> {
    let mut seen = HashSet::new();
    references
        .iter()
        .filter(|reference| reference.kind == "scene")
        .chain(
            references
                .iter()
                .filter(|reference| reference.kind == "character"),
        )
        .chain(references.iter().filter(|reference| {
            !matches!(
                reference.kind.as_str(),
                "scene" | "character" | "shot_first_frame" | "shot_reference"
            )
        }))
        .chain(references.iter().filter(|reference| {
            matches!(
                reference.kind.as_str(),
                "shot_first_frame" | "shot_reference"
            )
        }))
        .filter_map(|reference| {
            if matches!(
                reference.kind.as_str(),
                "shot_first_frame" | "shot_reference"
            ) || seen.insert(reference.data_url.as_str())
            {
                Some(reference)
            } else {
                None
            }
        })
        .collect()
}

fn ordered_video_reference_log_details(references: &[ReferenceImage]) -> Vec<Value> {
    ordered_video_references(references)
        .into_iter()
        .map(reference_log_detail)
        .collect()
}

fn validated_video_options(
    model: &str,
    resolution: Option<&str>,
    version: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    match model {
        "hailuo-h3-cankaosheng" => {
            let resolution = resolution.unwrap_or("768P");
            if !matches!(resolution, "768P" | "2K") {
                return Err(error(
                    "AI_VIDEO_RESOLUTION_INVALID",
                    "海螺 MiniMax-H3 仅支持 768P 或 2K",
                    false,
                ));
            }
            Ok((Some(resolution.into()), None))
        }
        "kwvideo-v2-ref" => {
            let version = version.unwrap_or("标准");
            if !matches!(version, "Mini" | "快速" | "标准") {
                return Err(error(
                    "AI_VIDEO_VERSION_INVALID",
                    "Seedance2.0 版本仅支持 Mini、Fast 或标准版",
                    false,
                ));
            }
            let resolution = resolution.unwrap_or("720p");
            let supported = if version == "标准" {
                matches!(resolution, "480p" | "720p" | "1080p" | "4K")
            } else {
                matches!(resolution, "480p" | "720p")
            };
            if !supported {
                return Err(error(
                    "AI_VIDEO_RESOLUTION_INVALID",
                    if version == "标准" {
                        "Seedance2.0 标准版支持 480p、720p、1080p 或 4K"
                    } else {
                        "Seedance2.0 Mini 和 Fast 版本仅支持 480p 或 720p"
                    },
                    false,
                ));
            }
            Ok((Some(resolution.into()), Some(version.into())))
        }
        "omni_flash-10s" => Ok((None, None)),
        _ => {
            let resolution = resolution.unwrap_or("720p");
            if resolution.trim().is_empty() {
                return Err(error(
                    "AI_VIDEO_RESOLUTION_INVALID",
                    "请选择有效的视频分辨率",
                    false,
                ));
            }
            Ok((Some(resolution.into()), version.map(str::to_owned)))
        }
    }
}

fn video_media_payload(
    model: &str,
    prompt: &str,
    aspect_ratio: &str,
    duration: f64,
    resolution: Option<&str>,
    version: Option<&str>,
    references: &[ReferenceImage],
) -> Result<Value, String> {
    let (resolution, version) = validated_video_options(model, resolution, version)?;
    let ordered_references = ordered_video_references(references);
    let images = ordered_references
        .iter()
        .map(|reference| reference.data_url.clone())
        .collect::<Vec<_>>();
    let reference_guide = ordered_references
        .iter()
        .enumerate()
        .map(|(index, reference)| format!("第{}张：{}", index + 1, reference.label))
        .collect::<Vec<_>>()
        .join("\n");
    let effective_prompt = if reference_guide.is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n参考图对应关系：\n{reference_guide}")
    };
    let total_bytes = references
        .iter()
        .map(|reference| reference.bytes.len())
        .sum::<usize>();
    if references
        .iter()
        .any(|reference| reference.bytes.len() > 10 * 1024 * 1024)
        || total_bytes > 30 * 1024 * 1024
    {
        return Err(error(
            "AI_VIDEO_REFERENCE_TOO_LARGE",
            "视频模型参考图单张不能超过 10MB，合计不能超过 30MB",
            false,
        ));
    }

    let whole_duration = duration.round().clamp(4.0, 15.0) as u64;
    let params = match model {
        "hailuo-h3-cankaosheng" => {
            if images.is_empty() || images.len() > 9 {
                return Err(error(
                    "AI_VIDEO_REFERENCE_COUNT_INVALID",
                    "海螺 MiniMax-H3 必须提供 1～9 张已生成的场景图、角色图或分镜图",
                    false,
                ));
            }
            json!({
                "duration": whole_duration,
                "aspect_ratio": aspect_ratio,
                "resolution": resolution,
                "images": images,
            })
        }
        "kwvideo-v2-ref" => {
            if images.is_empty() || images.len() > 9 {
                return Err(error(
                    "AI_VIDEO_REFERENCE_COUNT_INVALID",
                    "Seedance2.0 必须提供 1～9 张已生成的场景图、角色图或分镜图",
                    false,
                ));
            }
            json!({
                "version": version,
                "duration": whole_duration,
                "aspect_ratio": aspect_ratio,
                "resolution": resolution,
                "images": images,
            })
        }
        "omni_flash-10s" => {
            if images.len() > 7 {
                return Err(error(
                    "AI_VIDEO_REFERENCE_COUNT_INVALID",
                    "白起-Flash 最多支持 7 张参考图",
                    false,
                ));
            }
            json!({
                "aspect_ratio": aspect_ratio,
                "images": images,
            })
        }
        _ => json!({
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "images": images,
        }),
    };

    Ok(json!({
        "model": model,
        "prompt": effective_prompt,
        "params": params,
    }))
}

async fn create_video_remote_task(
    client: &Client,
    project_root: &Path,
    record: &crate::database::generation_records::GenerationRecord,
    api_key: &str,
    duration: f64,
    resolution: Option<&str>,
    version: Option<&str>,
    references: &[ReferenceImage],
) -> Result<Result<String, String>, String> {
    let payload = video_media_payload(
        &record.model,
        &record.prompt,
        &record.aspect_ratio,
        duration,
        resolution,
        version,
        references,
    )?;
    let endpoint = api_url(&record.base_url, "/v1/media/generate");
    let mut logged_payload = payload.clone();
    if let Some(params) = logged_payload
        .get_mut("params")
        .and_then(Value::as_object_mut)
    {
        if params.contains_key("images") {
            params.insert(
                "images".into(),
                json!(ordered_video_reference_log_details(references)),
            );
        }
    }
    crate::logging::debug(
        "ai.video.request",
        json!({
            "endpoint": endpoint,
            "protocol": "media",
            "authentication": "Bearer [REDACTED]",
            "record_id": record.id,
            "parameters": logged_payload,
            "reference_files": ordered_video_reference_log_details(references),
        }),
    );
    let request_bytes = serde_json::to_vec(&payload).map_err(|serialize_error| {
        error(
            "AI_VIDEO_REQUEST_INVALID",
            format!("无法序列化视频生成请求：{serialize_error}"),
            false,
        )
    })?;
    append_generation_log(
        project_root,
        "video_request_started",
        json!({
            "record_id": record.id,
            "endpoint": endpoint,
            "model": record.model,
            "protocol": "media",
            "aspect_ratio": record.aspect_ratio,
            "duration": duration,
            "resolution": resolution,
            "prompt_characters": record.prompt.chars().count(),
            "reference_count": references.len(),
            "reference_bytes": references.iter().map(|reference| reference.bytes.len()).sum::<usize>(),
            "request_bytes": request_bytes.len(),
            "references": references.iter().map(|reference| json!({
                "label": reference.label,
                "kind": reference.kind,
                "filename": reference.filename,
                "mime_type": reference.mime_type,
                "bytes": reference.bytes.len(),
            })).collect::<Vec<_>>(),
        }),
    );
    let started = Instant::now();
    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .body(request_bytes)
        .send()
        .await
        .map_err(|request_error| {
            let detail = reqwest_error_detail(&request_error);
            crate::logging::error(
                "ai.video.request_failed",
                json!({"endpoint": endpoint, "record_id": record.id, "model": record.model, "error": detail}),
            );
            append_generation_log(
                project_root,
                "video_request_network_error",
                json!({
                    "record_id": record.id,
                    "endpoint": endpoint,
                    "elapsed_ms": started.elapsed().as_millis(),
                    "error": detail,
                    "debug": format!("{request_error:?}"),
                }),
            );
            error(
                "AI_VIDEO_GENERATION_NETWORK_ERROR",
                format!("无法创建视频生成任务：{detail}"),
                true,
            )
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|request_error| {
        let detail = reqwest_error_detail(&request_error);
        append_generation_log(
            project_root,
            "video_response_read_error",
            json!({
                "record_id": record.id,
                "status": status.as_u16(),
                "elapsed_ms": started.elapsed().as_millis(),
                "error": detail,
            }),
        );
        error(
            "AI_VIDEO_GENERATION_NETWORK_ERROR",
            format!("读取视频生成接口响应失败：{detail}"),
            true,
        )
    })?;
    append_generation_log(
        project_root,
        "video_response_received",
        json!({
            "record_id": record.id,
            "status": status.as_u16(),
            "elapsed_ms": started.elapsed().as_millis(),
            "body": response_excerpt(&body),
        }),
    );
    let created: Value = serde_json::from_str(&body).map_err(|parse_error| {
        error(
            "AI_VIDEO_GENERATION_RESPONSE_INVALID",
            format!("视频生成接口返回的内容不是有效 JSON：{parse_error}"),
            true,
        )
    })?;
    if !status.is_success() {
        return Err(response_error(status, &created));
    }
    if let Some(message) = media_application_error(&created) {
        return Err(error("AI_VIDEO_GENERATION_FAILED", message, true));
    }
    if let Some(url) = media_result_url(&created) {
        return Ok(Err(url));
    }
    media_task_id(&created).map(Ok).ok_or_else(|| {
        error(
            "AI_VIDEO_GENERATION_RESPONSE_INVALID",
            "视频生成接口没有返回 task_id 或视频地址",
            true,
        )
    })
}

async fn poll_video_url(
    client: &Client,
    record: &crate::database::generation_records::GenerationRecord,
    api_key: &str,
    remote_id: &str,
) -> Result<String, String> {
    let status_url = api_url(
        &record.base_url,
        &format!("/v1/skills/task-status?task_id={remote_id}"),
    );
    for _ in 0..1440 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let response = client
            .get(&status_url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| {
                error(
                    "AI_VIDEO_GENERATION_STATUS_ERROR",
                    format!("无法查询视频生成任务：{e}"),
                    true,
                )
            })?;
        let status = response_json(response).await?;
        if let Some(message) = media_application_error(&status) {
            return Err(error("AI_VIDEO_GENERATION_STATUS_ERROR", message, true));
        }
        let data = status.get("data").unwrap_or(&status);
        let state = data
            .get("state")
            .or_else(|| data.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("running")
            .to_ascii_lowercase();
        let is_final = data
            .get("is_final")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if matches!(
            state.as_str(),
            "success" | "succeeded" | "completed" | "complete"
        ) || (is_final && !matches!(state.as_str(), "failed" | "error"))
        {
            return media_result_url(&status).ok_or_else(|| {
                error(
                    "AI_VIDEO_GENERATION_RESPONSE_INVALID",
                    "视频生成任务完成但缺少结果地址",
                    true,
                )
            });
        }
        if matches!(state.as_str(), "failed" | "error" | "cancelled") || is_final {
            let message = data
                .get("error")
                .or_else(|| data.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("视频生成任务失败");
            return Err(error("AI_VIDEO_GENERATION_FAILED", message, true));
        }
    }
    Err(error(
        "AI_VIDEO_GENERATION_TIMEOUT",
        "等待视频生成任务完成超时",
        true,
    ))
}

async fn download_video_result(
    project_root: &Path,
    record: &crate::database::generation_records::GenerationRecord,
    url_value: &str,
) -> Result<(), String> {
    let url = validate_remote_image_url(url_value)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| error("AI_CLIENT_ERROR", e.to_string(), false))?;
    let mut response = client.get(url.clone()).send().await.map_err(|e| {
        error(
            "AI_VIDEO_DOWNLOAD_ERROR",
            format!("无法下载生成视频：{e}"),
            true,
        )
    })?;
    if !response.status().is_success() {
        return Err(error(
            "AI_VIDEO_DOWNLOAD_ERROR",
            format!("下载生成视频失败（{}）", response.status().as_u16()),
            true,
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > 2 * 1024 * 1024 * 1024)
    {
        return Err(error("AI_VIDEO_DOWNLOAD_ERROR", "生成视频超过 2GB", false));
    }
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("video/mp4")
        .split(';')
        .next()
        .unwrap_or("video/mp4")
        .to_owned();
    let extension = if mime_type.contains("webm")
        || url.path().to_ascii_lowercase().ends_with(".webm")
    {
        "webm"
    } else if mime_type.contains("quicktime") || url.path().to_ascii_lowercase().ends_with(".mov") {
        "mov"
    } else {
        "mp4"
    };
    let relative_dir = PathBuf::from("shots/videos");
    let target_dir = project_root.join(&relative_dir);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| error("AI_VIDEO_WRITE_ERROR", e.to_string(), true))?;
    let filename = format!(
        "{}_{}.{}",
        record.target_id,
        Utc::now().timestamp_millis(),
        extension
    );
    let absolute_path = target_dir.join(filename);
    let temporary_path = absolute_path.with_extension(format!("{extension}.part"));
    let mut file = tokio::fs::File::create(&temporary_path)
        .await
        .map_err(|e| error("AI_VIDEO_WRITE_ERROR", e.to_string(), true))?;
    let mut written = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| error("AI_VIDEO_DOWNLOAD_ERROR", e.to_string(), true))?
    {
        written += chunk.len() as u64;
        if written > 2 * 1024 * 1024 * 1024 {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(error("AI_VIDEO_DOWNLOAD_ERROR", "生成视频超过 2GB", false));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| error("AI_VIDEO_WRITE_ERROR", e.to_string(), true))?;
    }
    file.flush()
        .await
        .map_err(|e| error("AI_VIDEO_WRITE_ERROR", e.to_string(), true))?;
    drop(file);
    if written == 0 {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error("AI_VIDEO_DOWNLOAD_ERROR", "生成视频内容为空", true));
    }
    tokio::fs::rename(&temporary_path, &absolute_path)
        .await
        .map_err(|e| error("AI_VIDEO_WRITE_ERROR", e.to_string(), true))?;
    let relative_path = relative_dir
        .join(absolute_path.file_name().unwrap_or_default())
        .to_string_lossy()
        .replace('\\', "/");
    let mut connection = crate::database::open(project_root)?;
    crate::database::generation_records::complete_video(
        &mut connection,
        &record.id,
        &relative_path,
        &absolute_path.to_string_lossy(),
        &mime_type,
    )
}

fn spawn_video_task(project_root: PathBuf, record_id: String) {
    let should_spawn = active_video_tasks()
        .lock()
        .map(|mut active| active.insert(record_id.clone()))
        .unwrap_or(false);
    if !should_spawn {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let permit = video_task_limiter().acquire_owned().await;
        let result = match permit {
            Ok(_permit) => execute_video_task(&project_root, &record_id).await,
            Err(error) => Err(format!("视频生成并发队列不可用：{error}")),
        };
        if let Err(message) = result {
            crate::logging::error(
                "ai.video.task_failed",
                json!({"project_path": project_root, "record_id": record_id, "error": message}),
            );
            append_generation_log(
                &project_root,
                "video_task_failed",
                json!({"record_id": record_id, "error": message}),
            );
            if let Ok(connection) = crate::database::open(&project_root) {
                let _ =
                    crate::database::generation_records::fail(&connection, &record_id, &message);
            }
        }
        if let Ok(mut active) = active_video_tasks().lock() {
            active.remove(&record_id);
        }
    });
}

async fn execute_video_task(project_root: &Path, record_id: &str) -> Result<(), String> {
    let connection = crate::database::open(project_root)?;
    let record = crate::database::generation_records::get(&connection, record_id)?
        .ok_or_else(|| format!("找不到视频生成流水：{record_id}"))?;
    let duration = record
        .result
        .as_ref()
        .and_then(|value| value.get("duration"))
        .and_then(Value::as_f64)
        .unwrap_or(10.0);
    let resolution = record
        .result
        .as_ref()
        .and_then(|value| value.get("resolution"))
        .and_then(Value::as_str);
    let version = record
        .result
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str);
    let reference_assets = reference_inputs(record.result.as_ref());
    if matches!(
        record.status.as_str(),
        crate::database::generation_records::STATUS_COMPLETED
            | crate::database::generation_records::STATUS_FAILED
    ) {
        return Ok(());
    }
    crate::database::generation_records::mark_running(&connection, record_id)?;
    drop(connection);
    let references = load_reference_images(project_root, &reference_assets)?;
    if record.protocol != "platform" { return Err(error("PLATFORM_MEDIA_MODEL_REQUIRED", "旧版视频生成方式已停用，请重新选择生成方案，确认积分后再开始", false)); }
    let api_key = String::new();
    let client = Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| error("AI_CLIENT_ERROR", e.to_string(), false))?;
    let result_url = if record.protocol == "platform" {
        let metadata = record.result.as_ref().cloned().unwrap_or_else(|| json!({}));
        let provider_model_id = metadata.get("provider_model_id").and_then(Value::as_str).ok_or_else(|| error("PLATFORM_MEDIA_MODEL_REQUIRED", "视频任务缺少服务端模型编号", false))?;
        let resolution = resolution.ok_or_else(|| error("PLATFORM_MEDIA_RESOLUTION_REQUIRED", "视频任务缺少分辨率", false))?;
        let reference_images = references.iter().map(|reference| json!({"data_url": reference.data_url, "label": reference.label, "type": reference.kind})).collect::<Vec<_>>();
        let operation = format!("分镜视频生成 · {}", record.target_id);
        let value = crate::platform_media::generate(&record.base_url, provider_model_id, record_id, json!({
            "prompt": record.prompt, "aspect_ratio": record.aspect_ratio, "duration": duration, "seconds": duration,
            "resolution": resolution, "version": version, "reference_images": reference_images,
            "params": {"aspect_ratio": record.aspect_ratio, "duration": duration, "seconds": duration, "resolution": resolution, "version": version, "reference_images": reference_images}
        }), &operation, metadata.get("workflow_credit_id").and_then(Value::as_str).map(|id| (project_root, id, format!("video:shot:{}", record.target_id)))).await?;
        media_result_url(&value).or_else(|| find_media_value(&value, &["video_url", "result_url", "url"], 0).map(str::to_owned)).ok_or_else(|| error("AI_VIDEO_RESPONSE_INVALID", "服务端视频生成结果中没有找到视频地址", true))?
    } else if let Some(remote_id) = record.remote_task_id.as_deref() {
        let connection = crate::database::open(project_root)?;
        crate::database::generation_records::mark_remote_processing(
            &connection,
            record_id,
            remote_id,
        )?;
        drop(connection);
        poll_video_url(&client, &record, &api_key, remote_id).await?
    } else {
        match create_video_remote_task(
            &client,
            project_root,
            &record,
            &api_key,
            duration,
            resolution,
            version,
            &references,
        )
        .await?
        {
            Ok(remote_id) => {
                let connection = crate::database::open(project_root)?;
                crate::database::generation_records::mark_remote_processing(
                    &connection,
                    record_id,
                    &remote_id,
                )?;
                drop(connection);
                append_generation_log(
                    project_root,
                    "video_remote_task_created",
                    json!({"record_id": record_id, "remote_task_id": remote_id}),
                );
                poll_video_url(&client, &record, &api_key, &remote_id).await?
            }
            Err(url) => url,
        }
    };
    let connection = crate::database::open(project_root)?;
    crate::database::generation_records::mark_downloading(&connection, record_id)?;
    drop(connection);
    download_video_result(project_root, &record, &result_url).await?;
    append_generation_log(
        project_root,
        "video_task_completed",
        json!({"record_id": record_id}),
    );
    Ok(())
}

#[tauri::command]
pub fn create_shot_video_generation(
    _app: tauri::AppHandle,
    input: CreateShotVideoGenerationInput,
) -> Result<crate::database::generation_records::GenerationRecord, String> {
    let project_root = validate_project_root(&input.project_path)?;
    let mut reference_assets = input.reference_assets.clone();
    if input.first_frame_relative_path.is_some()
        && reference_assets
            .iter()
            .any(|reference| reference.kind == "shot_reference")
    {
        return Err(error(
            "AI_VIDEO_SHOT_IMAGE_MODE_CONFLICT",
            "分镜图不能同时作为视频首帧和视频整体参考图",
            false,
        ));
    }
    if let Some(first_frame) = input.first_frame_relative_path.as_deref() {
        reference_assets.push(GenerationReferenceAssetInput {
            relative_path: first_frame.to_owned(),
            label: "分镜图（视频首帧）".into(),
            kind: "shot_first_frame".into(),
        });
    }
    load_reference_images(&project_root, &reference_assets)?;
    if input.shot_id.is_empty()
        || !input
            .shot_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(error("AI_VIDEO_TARGET_INVALID", "分镜编号无效", false));
    }
    if !(10..=30_000).contains(&input.prompt.trim().chars().count()) {
        return Err(error(
            "AI_VIDEO_PROMPT_INVALID",
            "视频生成提示词长度必须在 10 到 30000 个字符之间",
            false,
        ));
    }
    if !matches!(input.aspect_ratio.as_str(), "9:16" | "16:9") {
        return Err(error(
            "AI_VIDEO_ASPECT_RATIO_INVALID",
            "画面比例必须是 9:16 或 16:9",
            false,
        ));
    }
    if !(1.0..=60.0).contains(&input.duration) {
        return Err(error(
            "AI_VIDEO_DURATION_INVALID",
            "视频时长必须在 1 到 60 秒之间",
            false,
        ));
    }
    if input.provider_model_id.trim().is_empty() || input.model_alias.trim().is_empty() {
        return Err(error("PLATFORM_MEDIA_MODEL_REQUIRED", "请选择服务端视频模型", false));
    }
    let resolution = input.resolution.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| error("PLATFORM_MEDIA_RESOLUTION_REQUIRED", "请选择视频分辨率", false))?.to_owned();
    let version = input.version.clone();
    let connection = crate::database::open(&project_root)?;
    let actual_project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    if actual_project_id != input.project_id {
        return Err(error("PROJECT_INVALID", "项目编号与项目目录不匹配", false));
    }
    let shot_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM shots WHERE id = ?1)",
            [&input.shot_id],
            |row| row.get(0),
        )
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    if !shot_exists {
        return Err(error(
            "AI_VIDEO_TARGET_INVALID",
            "项目中不存在该分镜",
            false,
        ));
    }
    if crate::database::generation_records::has_unfinished_video(
        &connection,
        &input.project_id,
        &input.shot_id,
    )? {
        return Err(error(
            "AI_VIDEO_TASK_EXISTS",
            "该分镜已有正在执行的视频生成任务",
            false,
        ));
    }
    let record = crate::database::generation_records::create(
        &connection,
        crate::database::generation_records::NewGenerationRecord {
            project_id: &input.project_id,
            media_type: "video",
            target_type: "shot",
            target_id: &input.shot_id,
            base_url: &input.platform_api_base_url,
            model: &input.model_alias,
            protocol: "platform",
            prompt: input.prompt.trim(),
            aspect_ratio: &input.aspect_ratio,
        },
    )?;
    crate::database::generation_records::set_request_metadata(
        &connection,
        &record.id,
        &json!({"duration": input.duration, "resolution": resolution, "version": version, "reference_assets": reference_assets, "provider_model_id": input.provider_model_id, "workflow_credit_id": input.workflow_credit_id}),
    )?;
    drop(connection);
    spawn_video_task(project_root, record.id.clone());
    Ok(record)
}

fn project_asset_path(project_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(project_root)
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    let relative = PathBuf::from(relative_path);
    if relative.is_absolute() {
        return Err(error(
            "PROJECT_VIDEO_ASSET_INVALID",
            "分镜视频必须使用项目内相对路径",
            false,
        ));
    }
    let path = fs::canonicalize(canonical_root.join(relative))
        .map_err(|e| error("PROJECT_VIDEO_ASSET_MISSING", e.to_string(), false))?;
    if !path.starts_with(&canonical_root) || !path.is_file() {
        return Err(error(
            "PROJECT_VIDEO_ASSET_INVALID",
            "分镜视频路径超出项目目录或文件不存在",
            false,
        ));
    }
    Ok(path)
}

fn ordered_shot_video_paths(
    project_root: &Path,
    project_id: &str,
    shot_ids: &[String],
) -> Result<Vec<PathBuf>, String> {
    let connection = crate::database::open(project_root)?;
    let records = crate::database::generation_records::list_for_project(&connection, project_id)?;
    shot_ids
        .iter()
        .map(|shot_id| {
            let relative_path = records
                .iter()
                .find(|record| {
                    record.media_type == "video"
                        && record.target_type == "shot"
                        && record.target_id == *shot_id
                        && record.status == crate::database::generation_records::STATUS_COMPLETED
                        && record.result_relative_path.is_some()
                })
                .and_then(|record| record.result_relative_path.as_deref())
                .ok_or_else(|| {
                    error(
                        "PROJECT_VIDEO_SHOT_MISSING",
                        format!("分镜 {shot_id} 尚未生成可用视频，无法合成"),
                        false,
                    )
                })?;
            project_asset_path(project_root, relative_path)
        })
        .collect()
}

fn media_command_output(command: &mut Command, action: &str) -> Result<(), String> {
    let output = command.output().map_err(|e| {
        error(
            "FFMPEG_NOT_AVAILABLE",
            format!("无法启动 FFmpeg 执行{action}：{e}"),
            false,
        )
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr: String = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(2_000)
        .collect();
    Err(error(
        "PROJECT_VIDEO_COMPOSE_FAILED",
        format!("FFmpeg {action}失败：{stderr}"),
        true,
    ))
}

#[derive(Debug, Clone, Copy)]
struct MediaProbe {
    has_audio: bool,
    video_duration: f64,
}

fn rational_value(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    (denominator.abs() > f64::EPSILON).then_some(numerator / denominator)
}

fn media_probe_from_value(value: &Value) -> Result<MediaProbe, String> {
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| error("PROJECT_VIDEO_PROBE_FAILED", "媒体信息缺少流列表", false))?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| error("PROJECT_VIDEO_PROBE_FAILED", "分镜文件中没有视频流", false))?;
    let frame_duration = video
        .get("nb_read_frames")
        .and_then(Value::as_str)
        .and_then(|frames| frames.parse::<f64>().ok())
        .zip(
            video
                .get("avg_frame_rate")
                .and_then(Value::as_str)
                .and_then(rational_value),
        )
        .and_then(|(frames, rate)| (frames > 0.0 && rate > 0.0).then_some(frames / rate));
    let stream_duration = video
        .get("duration")
        .and_then(Value::as_str)
        .and_then(|duration| duration.parse::<f64>().ok());
    let format_duration = value
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|duration| duration.parse::<f64>().ok());
    // Decoded frame count is authoritative when a container or long audio
    // stream advertises a duration beyond the last real video frame.
    let video_duration = frame_duration
        .or(stream_duration)
        .or(format_duration)
        .filter(|duration| duration.is_finite() && *duration >= 0.05 && *duration <= 3_600.0)
        .ok_or_else(|| {
            error(
                "PROJECT_VIDEO_PROBE_FAILED",
                "无法确定分镜视频的真实画面时长",
                false,
            )
        })?;
    Ok(MediaProbe {
        has_audio: streams
            .iter()
            .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio")),
        video_duration,
    })
}

fn probe_media(ffprobe: &Path, path: &Path) -> Result<MediaProbe, String> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=codec_type,duration,nb_read_frames,avg_frame_rate:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|e| {
            error(
                "FFPROBE_NOT_AVAILABLE",
                format!("无法启动 FFprobe 检查分镜视频音轨：{e}"),
                false,
            )
        })?;
    if !output.status.success() {
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(1_000)
            .collect();
        return Err(error(
            "PROJECT_VIDEO_PROBE_FAILED",
            format!("无法读取分镜视频媒体信息：{stderr}"),
            false,
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| {
        error(
            "PROJECT_VIDEO_PROBE_FAILED",
            format!("无法解析分镜视频媒体信息：{e}"),
            false,
        )
    })?;
    media_probe_from_value(&value)
}

fn execute_project_video_composition(project_root: &Path, record_id: &str) -> Result<(), String> {
    let connection = crate::database::open(project_root)?;
    let record = crate::database::generation_records::get(&connection, record_id)?
        .ok_or_else(|| format!("找不到项目视频合成流水：{record_id}"))?;
    if matches!(
        record.status.as_str(),
        crate::database::generation_records::STATUS_COMPLETED
            | crate::database::generation_records::STATUS_FAILED
    ) {
        return Ok(());
    }
    let shot_ids: Vec<String> = record
        .result
        .as_ref()
        .and_then(|value| value.get("ordered_shot_ids"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| {
            error(
                "PROJECT_VIDEO_METADATA_INVALID",
                "合成任务缺少分镜顺序",
                false,
            )
        })?;
    crate::database::generation_records::mark_running(&connection, record_id)?;
    drop(connection);

    let input_paths = ordered_shot_video_paths(project_root, &record.project_id, &shot_ids)?;
    let ffmpeg = crate::media_tools::resolve("ffmpeg", "AIVS_FFMPEG_PATH")
        .map_err(|message| error("FFMPEG_NOT_AVAILABLE", message, false))?;
    let ffprobe = crate::media_tools::resolve("ffprobe", "AIVS_FFPROBE_PATH")
        .map_err(|message| error("FFPROBE_NOT_AVAILABLE", message, false))?;
    let (target_width, target_height) = if record.aspect_ratio == "16:9" {
        (1280, 720)
    } else {
        (720, 1280)
    };
    let output_dir = project_root
        .join("assets")
        .join("generated")
        .join("project");
    fs::create_dir_all(&output_dir).map_err(|e| {
        error(
            "PROJECT_VIDEO_OUTPUT_ERROR",
            format!("无法创建合成视频目录：{e}"),
            true,
        )
    })?;
    let work_dir = output_dir.join(format!("{record_id}-work"));
    fs::create_dir_all(&work_dir).map_err(|e| {
        error(
            "PROJECT_VIDEO_OUTPUT_ERROR",
            format!("无法创建视频合成临时目录：{e}"),
            true,
        )
    })?;
    let concat_path = work_dir.join("concat.txt");
    let partial_path = output_dir.join(format!("{record_id}.partial.mp4"));
    let final_path = output_dir.join(format!("{record_id}.mp4"));
    let mut normalized_paths = Vec::with_capacity(input_paths.len());
    let mut expected_duration = 0.0;

    let composition_result = (|| -> Result<(), String> {
        for (index, input_path) in input_paths.iter().enumerate() {
            let normalized_path = work_dir.join(format!("segment-{index:04}.mp4"));
            let media = probe_media(&ffprobe, input_path)?;
            let duration = format!("{:.6}", media.video_duration);
            expected_duration += media.video_duration;
            let video_filter = format!(
                "trim=duration={duration},setpts=PTS-STARTPTS,scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30"
            );
            let audio_filter = format!(
                "aresample=async=1:first_pts=0,apad=whole_dur={duration},atrim=duration={duration},asetpts=PTS-STARTPTS"
            );
            let mut command = Command::new(&ffmpeg);
            command.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-fflags",
                "+genpts",
                "-i",
            ]);
            command.arg(input_path);
            if !media.has_audio {
                command.args([
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=48000",
                ]);
            }
            command.args(["-map", "0:v:0"]);
            command.args(if media.has_audio {
                ["-map", "0:a:0"]
            } else {
                ["-map", "1:a:0"]
            });
            command
                .args(["-vf", &video_filter])
                .args(["-af", &audio_filter])
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-t",
                    &duration,
                    "-fps_mode",
                    "cfr",
                    "-map_metadata",
                    "-1",
                    "-movflags",
                    "+faststart",
                ])
                .arg(&normalized_path);
            media_command_output(&mut command, &format!("规范化分镜视频 {}", index + 1))?;
            normalized_paths.push(normalized_path);
            let progress = 0.1 + 0.7 * ((index + 1) as f64 / input_paths.len() as f64);
            let connection = crate::database::open(project_root)?;
            crate::database::generation_records::update_progress(&connection, record_id, progress)?;
        }
        let concat_content = (0..normalized_paths.len())
            .map(|index| format!("file 'segment-{index:04}.mp4'"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&concat_path, format!("{concat_content}\n")).map_err(|e| {
            error(
                "PROJECT_VIDEO_OUTPUT_ERROR",
                format!("无法写入视频合成清单：{e}"),
                true,
            )
        })?;
        let mut concat_command = Command::new(&ffmpeg);
        concat_command
            .current_dir(&work_dir)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-fflags",
                "+genpts",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                "concat.txt",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
            ])
            .arg(&partial_path);
        media_command_output(&mut concat_command, "合并全部分镜视频")?;
        let composed = probe_media(&ffprobe, &partial_path)?;
        let duration_delta = (composed.video_duration - expected_duration).abs();
        let duration_tolerance = (expected_duration * 0.02).max(0.75);
        if duration_delta > duration_tolerance {
            return Err(error(
                "PROJECT_VIDEO_DURATION_INVALID",
                format!(
                    "合成视频时长异常：预计 {:.2} 秒，实际 {:.2} 秒",
                    expected_duration, composed.video_duration
                ),
                true,
            ));
        }
        if final_path.is_file() {
            fs::remove_file(&final_path).map_err(|e| {
                error(
                    "PROJECT_VIDEO_OUTPUT_ERROR",
                    format!("无法替换未完成任务遗留的合成视频：{e}"),
                    true,
                )
            })?;
        }
        fs::rename(&partial_path, &final_path).map_err(|e| {
            error(
                "PROJECT_VIDEO_OUTPUT_ERROR",
                format!("无法保存最终合成视频：{e}"),
                true,
            )
        })?;
        Ok(())
    })();

    for path in &normalized_paths {
        let _ = fs::remove_file(path);
    }
    let _ = fs::remove_file(&concat_path);
    let _ = fs::remove_dir(&work_dir);
    if composition_result.is_err() {
        let _ = fs::remove_file(&partial_path);
    }
    composition_result?;

    let relative_path = final_path
        .strip_prefix(project_root)
        .map_err(|e| error("PROJECT_VIDEO_OUTPUT_ERROR", e.to_string(), false))?
        .to_string_lossy()
        .replace('\\', "/");
    let mut connection = crate::database::open(project_root)?;
    crate::database::generation_records::complete_project_video(
        &mut connection,
        record_id,
        &relative_path,
        &final_path.to_string_lossy(),
        "video/mp4",
    )
}

fn spawn_project_video_composition(project_root: PathBuf, record_id: String) {
    let should_spawn = active_video_tasks()
        .lock()
        .map(|mut active| active.insert(record_id.clone()))
        .unwrap_or(false);
    if !should_spawn {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let permit = video_task_limiter().acquire_owned().await;
        let result = match permit {
            Ok(_permit) => {
                let task_root = project_root.clone();
                let task_id = record_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    execute_project_video_composition(&task_root, &task_id)
                })
                .await
                .map_err(|e| format!("视频合成任务异常：{e}"))
                .and_then(|result| result)
            }
            Err(e) => Err(format!("视频合成并发队列不可用：{e}")),
        };
        if let Err(message) = result {
            append_generation_log(
                &project_root,
                "project_video_composition_failed",
                json!({"record_id": record_id, "error": message}),
            );
            if let Ok(connection) = crate::database::open(&project_root) {
                let _ =
                    crate::database::generation_records::fail(&connection, &record_id, &message);
            }
        } else {
            append_generation_log(
                &project_root,
                "project_video_composition_completed",
                json!({"record_id": record_id}),
            );
        }
        if let Ok(mut active) = active_video_tasks().lock() {
            active.remove(&record_id);
        }
    });
}

#[tauri::command]
pub fn compose_project_video(
    input: ComposeProjectVideoInput,
) -> Result<crate::database::generation_records::GenerationRecord, String> {
    let project_root = validate_project_root(&input.project_path)?;
    if input.ordered_shot_ids.is_empty() || input.ordered_shot_ids.len() > 1_000 {
        return Err(error(
            "PROJECT_VIDEO_SHOTS_INVALID",
            "项目至少需要一个分镜，且不能超过 1000 个分镜",
            false,
        ));
    }
    if !matches!(input.aspect_ratio.as_str(), "9:16" | "16:9") {
        return Err(error(
            "PROJECT_VIDEO_ASPECT_RATIO_INVALID",
            "项目视频画面比例必须是 9:16 或 16:9",
            false,
        ));
    }
    let mut unique_ids = HashSet::new();
    if input.ordered_shot_ids.iter().any(|shot_id| {
        shot_id.is_empty()
            || !shot_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            || !unique_ids.insert(shot_id)
    }) {
        return Err(error(
            "PROJECT_VIDEO_SHOTS_INVALID",
            "分镜顺序中包含无效或重复的分镜编号",
            false,
        ));
    }
    let connection = crate::database::open(&project_root)?;
    let actual_project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    if actual_project_id != input.project_id {
        return Err(error("PROJECT_INVALID", "项目编号与项目目录不匹配", false));
    }
    for shot_id in &input.ordered_shot_ids {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM shots WHERE id = ?1 AND project_id = ?2)",
                [shot_id, &input.project_id],
                |row| row.get(0),
            )
            .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
        if !exists {
            return Err(error(
                "PROJECT_VIDEO_SHOTS_INVALID",
                format!("项目中不存在分镜 {shot_id}"),
                false,
            ));
        }
    }
    let existing_records =
        crate::database::generation_records::list_for_project(&connection, &input.project_id)?;
    if existing_records.iter().any(|record| {
        record.media_type == "video"
            && record.target_type == "project"
            && !matches!(
                record.status.as_str(),
                crate::database::generation_records::STATUS_COMPLETED
                    | crate::database::generation_records::STATUS_FAILED
            )
    }) {
        return Err(error(
            "PROJECT_VIDEO_TASK_EXISTS",
            "当前已有正在执行的项目视频合成任务",
            false,
        ));
    }
    drop(connection);
    ordered_shot_video_paths(&project_root, &input.project_id, &input.ordered_shot_ids)?;
    let connection = crate::database::open(&project_root)?;
    let prompt = format!(
        "按项目分镜顺序合成视频：{}",
        input.ordered_shot_ids.join(" → ")
    );
    let record = crate::database::generation_records::create(
        &connection,
        crate::database::generation_records::NewGenerationRecord {
            project_id: &input.project_id,
            media_type: "video",
            target_type: "project",
            target_id: &input.project_id,
            base_url: "local://ffmpeg",
            model: "FFmpeg",
            protocol: "local-compose",
            prompt: &prompt,
            aspect_ratio: &input.aspect_ratio,
        },
    )?;
    crate::database::generation_records::set_request_metadata(
        &connection,
        &record.id,
        &json!({"ordered_shot_ids": input.ordered_shot_ids}),
    )?;
    drop(connection);
    spawn_project_video_composition(project_root, record.id.clone());
    Ok(record)
}

#[tauri::command]
pub async fn list_generation_records(
    project_path: String,
) -> Result<Vec<crate::database::generation_records::GenerationRecord>, String> {
    crate::background::run("读取生成任务记录", move || {
        let project_root = validate_project_root(&project_path)?;
        let connection = crate::database::open(&project_root)?;
        let project_id: String = connection
            .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
            .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
        crate::database::generation_records::list_for_project(&connection, &project_id)
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct ExportGenerationAssetsResult {
    output_directory: String,
    exported_files: Vec<String>,
    skipped_count: usize,
}

fn generation_asset_path(project_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project_root)
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    let requested = PathBuf::from(relative_path);
    if requested.is_absolute() {
        return Err(error(
            "PROJECT_ASSET_INVALID",
            "项目资产路径必须是相对路径",
            false,
        ));
    }
    let path = fs::canonicalize(root.join(requested))
        .map_err(|e| error("PROJECT_ASSET_READ_ERROR", e.to_string(), false))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(error(
            "PROJECT_ASSET_INVALID",
            "项目资产路径超出项目目录",
            false,
        ));
    }
    Ok(path)
}

fn available_export_path(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let original = Path::new(file_name);
    let mut candidate = directory.join(original);
    if !candidate.exists() {
        return candidate;
    }
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-media");
    let extension = original.extension().and_then(|value| value.to_str());
    for index in 2_u32.. {
        let name = match extension {
            Some(extension) => format!("{stem}_{index}.{extension}"),
            None => format!("{stem}_{index}"),
        };
        candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[tauri::command]
pub fn save_generation_record_asset(
    project_path: String,
    record_id: String,
    output_path: String,
) -> Result<String, String> {
    let project_root = validate_project_root(&project_path)?;
    let connection = crate::database::open(&project_root)?;
    let record = crate::database::generation_records::get(&connection, record_id.trim())?
        .ok_or_else(|| error("GENERATION_RECORD_NOT_FOUND", "生成记录不存在", false))?;
    if record.status != crate::database::generation_records::STATUS_COMPLETED {
        return Err(error(
            "GENERATION_ASSET_NOT_READY",
            "该生成记录尚未完成，暂时无法另存",
            false,
        ));
    }
    let relative_path = record.result_relative_path.as_deref().ok_or_else(|| {
        error(
            "GENERATION_ASSET_MISSING",
            "生成记录中没有可保存的结果文件",
            false,
        )
    })?;
    let source = generation_asset_path(&project_root, relative_path)?;
    let output = PathBuf::from(output_path.trim());
    if !output.is_absolute() {
        return Err(error(
            "GENERATION_EXPORT_PATH_INVALID",
            "请选择有效的绝对保存路径",
            false,
        ));
    }
    let parent = output
        .parent()
        .ok_or_else(|| error("GENERATION_EXPORT_PATH_INVALID", "保存目录无效", false))?;
    if !parent.is_dir() {
        return Err(error(
            "GENERATION_EXPORT_PATH_INVALID",
            "保存目录不存在",
            false,
        ));
    }
    if output.exists()
        && fs::canonicalize(&output)
            .ok()
            .is_some_and(|path| path == source)
    {
        return Ok(output.to_string_lossy().into_owned());
    }
    fs::copy(&source, &output).map_err(|e| {
        error(
            "GENERATION_EXPORT_FAILED",
            format!("另存文件失败：{e}"),
            true,
        )
    })?;
    Ok(output.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn export_all_generation_assets(
    project_path: String,
    output_directory: String,
) -> Result<ExportGenerationAssetsResult, String> {
    let project_root = validate_project_root(&project_path)?;
    let output_directory = PathBuf::from(output_directory.trim());
    if !output_directory.is_absolute() || !output_directory.is_dir() {
        return Err(error(
            "GENERATION_EXPORT_PATH_INVALID",
            "请选择有效的导出文件夹",
            false,
        ));
    }
    let connection = crate::database::open(&project_root)?;
    let project_id: String = connection
        .query_row("SELECT id FROM projects LIMIT 1", [], |row| row.get(0))
        .map_err(|e| error("PROJECT_INVALID", e.to_string(), false))?;
    let records = crate::database::generation_records::list_for_project(&connection, &project_id)?;
    let mut exported_files = Vec::new();
    let mut skipped_count = 0_usize;
    for record in records {
        if record.status != crate::database::generation_records::STATUS_COMPLETED
            || !matches!(record.media_type.as_str(), "image" | "video")
        {
            skipped_count += 1;
            continue;
        }
        let Some(relative_path) = record.result_relative_path.as_deref() else {
            skipped_count += 1;
            continue;
        };
        let Ok(source) = generation_asset_path(&project_root, relative_path) else {
            skipped_count += 1;
            continue;
        };
        let Some(file_name) = source.file_name() else {
            skipped_count += 1;
            continue;
        };
        let destination = available_export_path(&output_directory, file_name);
        if fs::copy(&source, &destination).is_ok() {
            exported_files.push(destination.to_string_lossy().into_owned());
        } else {
            skipped_count += 1;
        }
    }
    Ok(ExportGenerationAssetsResult {
        output_directory: output_directory.to_string_lossy().into_owned(),
        exported_files,
        skipped_count,
    })
}

pub(crate) fn resume_project_video_tasks(
    project_root: &Path,
) -> Result<Vec<crate::database::generation_records::GenerationRecord>, String> {
    let connection = crate::database::open(project_root)?;
    let records = crate::database::generation_records::list_unfinished_videos(&connection)?;
    for record in &records {
        if record.target_type == "project" {
            spawn_project_video_composition(project_root.to_path_buf(), record.id.clone());
        } else {
            spawn_video_task(project_root.to_path_buf(), record.id.clone());
        }
    }
    Ok(records)
}

#[tauri::command]
pub fn read_project_asset(project_path: String, relative_path: String) -> Result<String, String> {
    let project_root = validate_project_root(&project_path)?;
    let path = generation_asset_path(&project_root, &relative_path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_video = matches!(extension.as_str(), "mp4" | "webm" | "mov");
    let bytes =
        fs::read(path).map_err(|e| error("PROJECT_ASSET_READ_ERROR", e.to_string(), true))?;
    let max_size = if is_video {
        500 * 1024 * 1024
    } else {
        40 * 1024 * 1024
    };
    if bytes.is_empty() || bytes.len() > max_size {
        return Err(error(
            "PROJECT_ASSET_INVALID",
            if is_video {
                "项目视频为空或超过 500MB"
            } else {
                "项目图片为空或超过 40MB"
            },
            false,
        ));
    }
    let mime = match extension.as_str() {
        "mp4" => "video/mp4".to_owned(),
        "webm" => "video/webm".to_owned(),
        "mov" => "video/quicktime".to_owned(),
        _ => image_mime(&bytes, None),
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_api_url_without_duplicate_slash() {
        assert_eq!(
            api_url("https://example.com/", "/v1beta/files"),
            "https://example.com/v1beta/files"
        );
        assert_eq!(
            openai_api_url("https://example.com/v1", "/v1/images/generations"),
            "https://example.com/v1/images/generations"
        );
    }

    #[test]
    fn extracts_all_text_parts() {
        let response = json!({"candidates": [{"content": {"parts": [{"text": "第一段"}, {"text": "第二段"}]}}]});
        assert_eq!(generated_text(&response).unwrap(), "第一段\n第二段");
    }

    #[test]
    fn recognizes_supported_video_mime_types() {
        assert_eq!(mime_type(Path::new("demo.MP4")), Some("video/mp4"));
        assert_eq!(mime_type(Path::new("demo.webm")), Some("video/webm"));
        assert_eq!(mime_type(Path::new("demo.mkv")), None);
    }

    #[test]
    fn recognizes_lingke_relay_without_matching_other_hosts() {
        assert!(is_lingke_relay("https://api.lk888.ai"));
        assert!(!is_lingke_relay(
            "https://generativelanguage.googleapis.com"
        ));
        assert!(!is_lingke_relay("https://api.lk888.ai.example.com"));
    }

    #[test]
    fn old_settings_files_receive_the_default_storyboard_prompt() {
        let settings: AiSettingsFile = serde_json::from_value(json!({
            "base_url": "https://api.example.com",
            "video_model": "gemini-test"
        }))
        .unwrap();
        assert_eq!(
            settings.video_storyboard_prompt,
            DEFAULT_VIDEO_STORYBOARD_PROMPT.trim()
        );
        assert_eq!(
            settings.video_storyboard_detailed_prompt,
            DEFAULT_VIDEO_STORYBOARD_DETAILED_PROMPT.trim()
        );
        assert_eq!(
            settings.character_image_prompt,
            DEFAULT_CHARACTER_IMAGE_PROMPT.trim()
        );
        assert_eq!(settings.image_model, "gpt-image-2");
        assert_eq!(settings.image_protocol, "openai");
        assert_eq!(settings.video_generation_model, "hailuo-h3-cankaosheng");
        assert_eq!(settings.video_generation_protocol, "media");
        assert_eq!(settings.credit_costs.image_per_item, 1.0);
        assert_eq!(settings.credit_costs.video_per_second.get("4K"), Some(&8.0));
    }

    #[test]
    fn extracts_json_from_fenced_idea_model_response() {
        let value = extract_json_object("```json\n{\"title\":\"归阵\"}\n```").unwrap();
        assert_eq!(value["title"], "归阵");
    }

    #[test]
    fn assembles_openai_streaming_text_chunks() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"title\\\":\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"归阵\\\"}\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(
            extract_openai_completion_content(body).unwrap(),
            "{\"title\":\"归阵\"}"
        );
    }

    #[test]
    fn retries_only_transient_text_model_http_statuses() {
        assert!(is_retryable_text_status(StatusCode::REQUEST_TIMEOUT));
        assert!(is_retryable_text_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_text_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_text_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_retryable_text_status(StatusCode::GATEWAY_TIMEOUT));
        assert!(!is_retryable_text_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_text_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_text_status(StatusCode::NOT_FOUND));
    }

    #[test]
    fn text_model_retry_delay_uses_bounded_exponential_backoff() {
        assert_eq!(text_retry_delay(1), Duration::from_secs(1));
        assert_eq!(text_retry_delay(2), Duration::from_secs(2));
        assert_eq!(text_retry_delay(3), Duration::from_secs(4));
        assert_eq!(text_retry_delay(8), Duration::from_secs(8));
    }

    #[test]
    fn extracts_media_task_ids_from_supported_response_shapes() {
        assert_eq!(
            media_task_id(&json!({"data": {"task_id": 123456}})).as_deref(),
            Some("123456")
        );
        assert_eq!(
            media_task_id(&json!({"data": {"task_ids": ["abc"]}})).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn decodes_base64_image_responses_and_blocks_local_urls() {
        let png = decode_image_base64("iVBORw0KGgo=", None).unwrap();
        assert_eq!(png.mime_type, "image/png");
        assert!(validate_remote_image_url("http://localhost/image.png").is_err());
        assert!(validate_remote_image_url("https://cdn.example.com/image.png").is_ok());
    }

    #[test]
    fn recognizes_media_application_errors() {
        assert!(media_application_error(&json!({"code": 200})).is_none());
        assert_eq!(
            media_application_error(&json!({"code": 500, "msg": "余额不足"})).as_deref(),
            Some("余额不足")
        );
    }

    #[test]
    fn builds_hailuo_reference_video_payload_with_images_inside_params() {
        let references = vec![
            ReferenceImage {
                label: "分镜首帧".into(),
                kind: "shot_first_frame".into(),
                filename: "shot.png".into(),
                bytes: vec![7, 8, 9],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,shot".into(),
            },
            ReferenceImage {
                label: "角色图一".into(),
                kind: "character".into(),
                filename: "character-one.png".into(),
                bytes: vec![1, 2, 3],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,character-one".into(),
            },
            ReferenceImage {
                label: "场景图".into(),
                kind: "scene".into(),
                filename: "scene.png".into(),
                bytes: vec![4, 5, 6],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,scene".into(),
            },
            ReferenceImage {
                label: "角色图二".into(),
                kind: "character".into(),
                filename: "character-two.png".into(),
                bytes: vec![10, 11, 12],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,character-two".into(),
            },
        ];
        let payload = video_media_payload(
            "hailuo-h3-cankaosheng",
            "测试视频",
            "9:16",
            9.7,
            Some("768P"),
            None,
            &references,
        )
        .unwrap();

        assert!(payload.get("images").is_none());
        assert_eq!(payload.pointer("/params/duration"), Some(&json!(10)));
        assert_eq!(payload.pointer("/params/resolution"), Some(&json!("768P")));
        assert_eq!(
            payload.pointer("/params/images/0"),
            Some(&json!("data:image/png;base64,scene"))
        );
        assert_eq!(
            payload.pointer("/params/images/1"),
            Some(&json!("data:image/png;base64,character-one"))
        );
        assert_eq!(
            payload.pointer("/params/images/2"),
            Some(&json!("data:image/png;base64,character-two"))
        );
        assert_eq!(
            payload.pointer("/params/images/3"),
            Some(&json!("data:image/png;base64,shot"))
        );
        assert!(payload
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| {
                prompt.contains("第1张：场景图")
                    && prompt.contains("第2张：角色图一")
                    && prompt.contains("第3张：角色图二")
                    && prompt.contains("第4张：分镜首帧")
            }));
        let logged_references = ordered_video_reference_log_details(&references);
        assert_eq!(logged_references[0].get("kind"), Some(&json!("scene")));
        assert_eq!(
            logged_references[3].get("kind"),
            Some(&json!("shot_first_frame"))
        );
    }

    #[test]
    fn sends_shot_image_as_a_regular_video_reference_when_requested() {
        let references = vec![
            ReferenceImage {
                label: "场景图".into(),
                kind: "scene".into(),
                filename: "scene.png".into(),
                bytes: vec![1, 2, 3],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,scene".into(),
            },
            ReferenceImage {
                label: "当前分镜图（视频整体参考图）".into(),
                kind: "shot_reference".into(),
                filename: "shot_reference.png".into(),
                bytes: vec![4, 5, 6],
                mime_type: "image/png".into(),
                data_url: "data:image/png;base64,shot-reference".into(),
            },
        ];
        let payload = video_media_payload(
            "hailuo-h3-cankaosheng",
            "分镜图参考要求：视频生成整体参考当前分镜图。",
            "16:9",
            10.0,
            Some("2K"),
            None,
            &references,
        )
        .unwrap();

        assert_eq!(
            payload.pointer("/params/images/1"),
            Some(&json!("data:image/png;base64,shot-reference"))
        );
        assert!(payload
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| {
                prompt.contains("分镜图参考要求：视频生成整体参考当前分镜图")
                    && prompt.contains("第2张：当前分镜图（视频整体参考图）")
            }));
    }

    #[test]
    fn hailuo_reference_video_requires_at_least_one_image() {
        assert!(video_media_payload(
            "hailuo-h3-cankaosheng",
            "测试视频",
            "16:9",
            10.0,
            Some("768P"),
            None,
            &[],
        )
        .is_err());
    }

    #[test]
    fn validates_seedance_version_resolution_combinations() {
        assert!(validated_video_options("kwvideo-v2-ref", Some("720p"), Some("Mini")).is_ok());
        assert!(validated_video_options("kwvideo-v2-ref", Some("720p"), Some("快速")).is_ok());
        assert!(validated_video_options("kwvideo-v2-ref", Some("4K"), Some("标准")).is_ok());
        assert!(validated_video_options("kwvideo-v2-ref", Some("1080p"), Some("Mini")).is_err());
        assert!(validated_video_options("kwvideo-v2-ref", Some("4K"), Some("快速")).is_err());
    }

    #[test]
    fn omni_flash_payload_omits_resolution_and_version() {
        let payload =
            video_media_payload("omni_flash-10s", "测试视频", "16:9", 10.0, None, None, &[])
                .unwrap();
        assert!(payload.pointer("/params/resolution").is_none());
        assert!(payload.pointer("/params/version").is_none());
    }

    #[test]
    fn media_probe_uses_real_video_frames_instead_of_long_container_audio() {
        let probe = media_probe_from_value(&json!({
            "streams": [
                {
                    "codec_type": "video",
                    "duration": "32.000000",
                    "nb_read_frames": "360",
                    "avg_frame_rate": "30/1"
                },
                {"codec_type": "audio", "duration": "32.000000"}
            ],
            "format": {"duration": "32.000000"}
        }))
        .unwrap();
        assert!(probe.has_audio);
        assert!((probe.video_duration - 12.0).abs() < f64::EPSILON);
    }
}
