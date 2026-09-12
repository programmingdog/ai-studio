use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const DEVELOPMENT_API_BASE_URL: &str = "http://localhost:3101/api/v1";
const PRODUCTION_API_BASE_URL: &str = "https://ai-studio.yuntianxing.net/api/v1";

fn api_base_url(configured: Option<&str>) -> Result<String, String> {
    let value = configured
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("AIVS_PLATFORM_API_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| option_env!("AIVS_PLATFORM_API_URL").map(str::to_owned))
        .unwrap_or_else(|| {
            if cfg!(debug_assertions) {
                DEVELOPMENT_API_BASE_URL.to_owned()
            } else {
                PRODUCTION_API_BASE_URL.to_owned()
            }
        });
    crate::platform_media::api_base_url(&value)
}

fn platform_error(status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("message").cloned())
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("平台 API 返回 HTTP {}", status.as_u16()));
    json!({
        "code": if status == StatusCode::UNAUTHORIZED { "PLATFORM_LOGIN_REQUIRED" } else { "SCRIPT_ANALYSIS_API_ERROR" },
        "message": message,
        "retryable": status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
    }).to_string()
}

pub async fn analyze_file(
    configured_api_base_url: Option<&str>,
    path: &Path,
    expected_credits: f64,
    idempotency_key: &str,
) -> Result<Value, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("无法读取剧本文件：{error}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("script.txt")
        .to_owned();
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" => "text/plain",
        "md" => "text/markdown",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pdf" => "application/pdf",
        _ => return Err("仅支持 TXT、MD、DOCX 或 PDF 剧本文件".to_owned()),
    };
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(35 * 60))
        .build()
        .map_err(|error| format!("无法创建平台 API 客户端：{error}"))?;
    let base = api_base_url(configured_api_base_url)?;
    let token = crate::platform_session::valid_access_token(&base).await?;
    let part = multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str(mime)
        .map_err(|error| format!("无法创建剧本上传内容：{error}"))?;
    let form = multipart::Form::new()
        .text("idempotency_key", idempotency_key.to_owned())
        .text("expected_credits", expected_credits.to_string())
        .part("script", part);
    let response = client
        .post(format!("{base}/tasks/script-analysis/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传剧本并等待文本大模型分析失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取剧本分析响应失败：{error}"))?;
    if !status.is_success() {
        return Err(platform_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("剧本分析响应格式无效：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_api_url_is_accepted_before_script_upload() {
        assert_eq!(
            api_base_url(Some("https://ai-studio.yuntianxing.net/api/v1/")).unwrap(),
            PRODUCTION_API_BASE_URL
        );
    }
}
