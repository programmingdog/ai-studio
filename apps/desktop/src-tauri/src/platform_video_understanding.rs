use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

use crate::ai::VideoUnderstandingResult;
const DEVELOPMENT_API_BASE_URL: &str = "http://localhost:3101/api/v1";
const PRODUCTION_API_BASE_URL: &str = "https://ai-studio.yuntianxing.net/api/v1";
fn api_base_url(task_url: Option<&str>) -> Result<String, String> {
    let configured = task_url
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("AIVS_PLATFORM_API_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| option_env!("AIVS_PLATFORM_API_URL").map(str::to_owned))
        });
    let value = configured.unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            DEVELOPMENT_API_BASE_URL.to_owned()
        } else {
            PRODUCTION_API_BASE_URL.to_owned()
        }
    });
    crate::platform_media::api_base_url(&value)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|error| format!("无法创建平台 API 客户端：{error}"))
}

fn platform_error(status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value.get("message").and_then(|message| {
                message.as_str().map(str::to_owned).or_else(|| {
                    message.as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("；")
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

fn video_data_error(error: String, mode: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if !normalized.contains("did not get any data blocks")
        && !error.contains("未读取到有效视频数据")
    {
        return error;
    }
    let message = if mode == "url" {
        "极速模式未能让大模型读取到视频数据。解析出来的临时地址可能已过期，或视频平台禁止大模型外部读取；请重新解析后再试，或改用详细模式。"
    } else {
        "详细模式上传完成后，大模型仍未读取到有效视频数据。请重新解析视频后重试；若仍失败，请检查视频格式或更换视频理解模型。"
    };
    let mut value = serde_json::from_str::<Value>(&error).unwrap_or_else(|_| json!({}));
    value["code"] = Value::String("VIDEO_MODEL_NO_DATA".to_owned());
    value["message"] = Value::String(message.to_owned());
    value["retryable"] = Value::Bool(true);
    value.to_string()
}

async fn response_value(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取平台 API 响应失败：{error}"))?;
    if !status.is_success() {
        return Err(platform_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("平台 API 响应格式无效：{error}"))
}

fn understanding_result(
    value: Value,
    video_name: String,
    size_bytes: u64,
    upload_mode: &str,
) -> Result<VideoUnderstandingResult, String> {
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
    Ok(VideoUnderstandingResult {
        text,
        model,
        upload_mode: upload_mode.to_owned(),
        video_name,
        size_bytes,
    })
}

pub async fn understand_public_url(
    configured_api_base_url: Option<&str>,
    video_url: &str,
    mime_type: &str,
    prompt: &str,
    video_name: String,
) -> Result<VideoUnderstandingResult, String> {
    let client = client()?;
    let base = api_base_url(configured_api_base_url)?;
    let quote = crate::platform_media::confirmed_quote(
        &base,
        None,
        Some("VIDEO_UNDERSTANDING"),
        &json!({}),
        "视频链接理解与分镜解析",
    )
    .await?;
    let token = crate::platform_session::valid_access_token(&base).await?;
    let response = client
        .post(format!("{base}/tasks/video-understanding/url"))
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
    let value = response_value(response)
        .await
        .map_err(|error| video_data_error(error, "url"))?;
    understanding_result(value, video_name, 0, "server-url")
}

pub async fn understand_uploaded_file(
    configured_api_base_url: Option<&str>,
    path: &Path,
    prompt: &str,
    original_name: String,
    original_size: u64,
) -> Result<VideoUnderstandingResult, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("无法读取压缩后的视频：{error}"))?;
    if bytes.is_empty() {
        return Err(json!({
            "code": "VIDEO_UPLOAD_EMPTY",
            "message": "详细模式准备上传的视频为空，请重新解析后再试。",
            "retryable": true
        })
        .to_string());
    }
    let client = client()?;
    let base = api_base_url(configured_api_base_url)?;
    let quote = crate::platform_media::confirmed_quote(
        &base,
        None,
        Some("VIDEO_UNDERSTANDING"),
        &json!({}),
        "本地视频理解与分镜解析",
    )
    .await?;
    let token = crate::platform_session::valid_access_token(&base).await?;
    let part = multipart::Part::bytes(bytes)
        .file_name("compressed-video.mp4")
        .mime_str("video/mp4")
        .map_err(|error| format!("无法创建视频上传内容：{error}"))?;
    let form = multipart::Form::new()
        .text("idempotency_key", uuid::Uuid::new_v4().to_string())
        .text(
            "provider_model_id",
            quote["provider_model_id"].as_str().unwrap_or("").to_owned(),
        )
        .text("expected_credits", quote["credits"].to_string())
        .text("prompt", crate::ai::video_understanding_prompt(prompt))
        .part("video", part);
    let response = client
        .post(format!("{base}/tasks/video-understanding/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传压缩视频到服务端失败：{error}"))?;
    let value = response_value(response)
        .await
        .map_err(|error| video_data_error(error, "upload"))?;
    understanding_result(value, original_name, original_size, "server-upload")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_api_url_is_accepted_before_requesting_credit_confirmation() {
        assert_eq!(
            api_base_url(Some("https://ai-studio.yuntianxing.net/api/v1/")).unwrap(),
            PRODUCTION_API_BASE_URL
        );
    }

    #[test]
    fn no_data_blocks_error_is_rewritten_with_fast_mode_recovery() {
        let error = video_data_error(
            json!({"message": "Did not get any data blocks"}).to_string(),
            "url",
        );
        let value: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(value["code"], "VIDEO_MODEL_NO_DATA");
        assert!(value["message"].as_str().unwrap().contains("改用详细模式"));
    }
}
