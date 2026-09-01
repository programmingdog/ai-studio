use reqwest::{multipart, Client, StatusCode, Url};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

use crate::ai::VideoUnderstandingResult;
use crate::platform_session::read_platform_session;

const DEVELOPMENT_API_BASE_URL: &str = "http://localhost:3101/api/v1";
const PRODUCTION_API_BASE_URL: &str = "https://ai-studio.yuntianxing.net/api/v1";
fn api_base_url(task_url: Option<&str>) -> Result<String, String> {
    let configured = task_url
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("AIVS_PLATFORM_API_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("AIVS_PLATFORM_API_URL").map(str::to_owned)));
    let value = configured.unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            DEVELOPMENT_API_BASE_URL.to_owned()
        } else {
            PRODUCTION_API_BASE_URL.to_owned()
        }
    });
    let parsed = Url::parse(value.trim()).map_err(|_| "平台 API 地址无效".to_owned())?;
    if parsed.scheme() != "https:"
        && parsed.host_str() != Some("localhost")
        && parsed.host_str() != Some("127.0.0.1")
    {
        return Err("平台 API 必须使用 HTTPS".to_owned());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|error| format!("无法创建平台 API 客户端：{error}"))
}

fn access_token() -> Result<String, String> {
    read_platform_session()?
        .map(|session| session.access_token)
        .ok_or_else(|| "请先登录平台账户".to_owned())
}

fn platform_error(status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value.get("message").and_then(|message| {
                message.as_str().map(str::to_owned).or_else(|| {
                    message.as_array().map(|items| {
                        items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("；")
                    })
                })
            })
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("平台 API 返回 HTTP {}", status.as_u16()));
    json!({
        "code": if status == StatusCode::UNAUTHORIZED { "PLATFORM_LOGIN_REQUIRED" } else { "PLATFORM_VIDEO_API_ERROR" },
        "message": message,
        "retryable": status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
    })
    .to_string()
}

async fn response_value(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("读取平台 API 响应失败：{error}"))?;
    if !status.is_success() {
        return Err(platform_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("平台 API 响应格式无效：{error}"))
}

fn understanding_result(value: Value, video_name: String, size_bytes: u64, upload_mode: &str) -> Result<VideoUnderstandingResult, String> {
    let provider_response = value.get("provider_response").ok_or_else(|| {
        json!({"code": "VIDEO_API_EMPTY_RESPONSE", "message": "服务端视频理解接口没有返回模型结果", "retryable": true}).to_string()
    })?;
    let text = crate::shot_policy::internalize_storyboard_dialogue_in_visual(
        &crate::ai::generated_text(provider_response)?,
    );
    let model = value
        .pointer("/task/logical_model_code")
        .and_then(Value::as_str)
        .unwrap_or("server-default-video-model")
        .to_owned();
    Ok(VideoUnderstandingResult { text, model, upload_mode: upload_mode.to_owned(), video_name, size_bytes })
}

pub async fn understand_public_url(
    configured_api_base_url: Option<&str>,
    video_url: &str,
    mime_type: &str,
    prompt: &str,
    video_name: String,
) -> Result<VideoUnderstandingResult, String> {
    let client = client()?;
    let quote = crate::platform_media::confirmed_quote(&api_base_url(configured_api_base_url)?, None, Some("VIDEO_UNDERSTANDING"), &json!({}), "视频链接理解与分镜解析").await?;
    let token = access_token()?;
    let response = client
        .post(format!("{}/tasks/video-understanding/url", api_base_url(configured_api_base_url)?))
        .bearer_auth(token)
        .json(&json!({
            "idempotency_key": uuid::Uuid::new_v4().to_string(),
            "provider_model_id": quote["provider_model_id"],
            "expected_credits": quote["credits"],
            "video_url": video_url,
            "mime_type": mime_type,
            "prompt": crate::ai::video_understanding_prompt(prompt),
        }))
        .send()
        .await
        .map_err(|error| format!("无法连接服务端视频理解接口：{error}"))?;
    understanding_result(response_value(response).await?, video_name, 0, "server-url")
}

pub async fn understand_uploaded_file(
    configured_api_base_url: Option<&str>,
    path: &Path,
    prompt: &str,
    original_name: String,
    original_size: u64,
) -> Result<VideoUnderstandingResult, String> {
    let bytes = tokio::fs::read(path).await.map_err(|error| format!("无法读取压缩后的视频：{error}"))?;
    let client = client()?;
    let quote = crate::platform_media::confirmed_quote(&api_base_url(configured_api_base_url)?, None, Some("VIDEO_UNDERSTANDING"), &json!({}), "本地视频理解与分镜解析").await?;
    let token = access_token()?;
    let part = multipart::Part::bytes(bytes)
        .file_name("compressed-video.mp4")
        .mime_str("video/mp4")
        .map_err(|error| format!("无法创建视频上传内容：{error}"))?;
    let form = multipart::Form::new()
        .text("idempotency_key", uuid::Uuid::new_v4().to_string())
        .text("provider_model_id", quote["provider_model_id"].as_str().unwrap_or("").to_owned())
        .text("expected_credits", quote["credits"].to_string())
        .text("prompt", crate::ai::video_understanding_prompt(prompt))
        .part("video", part);
    let response = client
        .post(format!("{}/tasks/video-understanding/upload", api_base_url(configured_api_base_url)?))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传压缩视频到服务端失败：{error}"))?;
    understanding_result(response_value(response).await?, original_name, original_size, "server-upload")
}
