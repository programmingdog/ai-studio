use reqwest::{Client, StatusCode, Url};
use serde_json::{json, Value};
use std::time::Duration;

use crate::platform_session::read_platform_session;

const DEVELOPMENT_API_BASE_URL: &str = "http://localhost:3101/api/v1";
const PRODUCTION_API_BASE_URL: &str = "https://ai-studio.yuntianxing.net/api/v1";
const QUOTE_MAX_ATTEMPTS: usize = 3;
const QUOTE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) fn api_base_url(configured: &str) -> Result<String, String> {
    let configured = if configured.trim().is_empty() {
        std::env::var("AIVS_PLATFORM_API_URL").ok().or_else(|| option_env!("AIVS_PLATFORM_API_URL").map(str::to_owned))
            .unwrap_or_else(|| if cfg!(debug_assertions) { DEVELOPMENT_API_BASE_URL.to_owned() } else { PRODUCTION_API_BASE_URL.to_owned() })
    } else { configured.trim().to_owned() };
    let value = configured.trim();
    let parsed = Url::parse(value).map_err(|_| "平台 API 地址无效".to_owned())?;
    let local_http = parsed.scheme() == "http" && matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1"));
    if parsed.scheme() != "https" && !local_http {
        return Err("平台 API 必须使用 HTTPS".to_owned());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

pub(crate) fn refresh_api_base_url(configured: &str) -> Result<String, String> {
    let base = api_base_url(configured)?;
    let configured_base = std::env::var("AIVS_PLATFORM_API_URL")
        .ok()
        .or_else(|| option_env!("AIVS_PLATFORM_API_URL").map(str::to_owned))
        .and_then(|value| api_base_url(&value).ok());
    if base == PRODUCTION_API_BASE_URL || base == DEVELOPMENT_API_BASE_URL || configured_base.as_deref() == Some(base.as_str()) {
        Ok(base)
    } else {
        Err("拒绝向非平台地址发送登录刷新令牌".to_owned())
    }
}

fn platform_error(status: StatusCode, body: &str) -> String {
    let structured = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    if structured["code"] == "TASK_NOT_SUBMITTED" && structured["retryable"].is_boolean() {
        return json!({"code":"TASK_NOT_SUBMITTED", "message":structured["message"], "retryable":structured["retryable"]}).to_string();
    }
    let message = serde_json::from_str::<Value>(body).ok()
        .and_then(|value| value.get("message").and_then(|message| message.as_str()).map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("平台 API 返回 HTTP {}", status.as_u16()));
    json!({"code": if status == StatusCode::UNAUTHORIZED { "PLATFORM_LOGIN_REQUIRED" } else { "PLATFORM_MEDIA_API_ERROR" }, "message": message, "retryable": status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS}).to_string()
}

async fn response_value(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("读取平台 API 响应失败：{error}"))?;
    if !status.is_success() { return Err(platform_error(status, &body)); }
    serde_json::from_str(&body).map_err(|error| format!("平台 API 响应格式无效：{error}"))
}

fn task_status(value: &Value) -> &str {
    value.pointer("/task/status").and_then(Value::as_str).unwrap_or("")
}

pub async fn generate(api_base: &str, provider_model_id: &str, local_task_id: &str, payload: Value, operation: &str, workflow: Option<(&std::path::Path, &str, String)>) -> Result<Value, String> {
    generate_request(api_base, Some(provider_model_id), None, local_task_id, payload, operation, workflow).await
}

pub async fn resume(api_base: &str, remote_task_id: &str, local_task_id: &str, workflow: Option<(&std::path::Path, &str, String)>) -> Result<Value, String> {
    let client = Client::builder().connect_timeout(Duration::from_secs(30)).timeout(Duration::from_secs(15 * 60)).build().map_err(|error| format!("无法创建平台 API 客户端：{error}"))?;
    let base = api_base_url(api_base)?;
    let token = crate::platform_session::valid_access_token(&base).await?;
    if let Some((root, _, _)) = &workflow {
        let receipt = crate::workflow_credit::receipt(root, local_task_id, &base)?
            .ok_or_else(|| crate::workflow_credit::error("登录账号与原任务不一致，自动制作已停止。"))?;
        if let Some(response) = receipt.response { return Ok(response); }
    }
    let result = wait_for_result(&client, &base, &token, json!({"task":{"id":remote_task_id,"status":"PROCESSING"}}), &workflow, local_task_id).await?;
    if let Some((root, _, _)) = &workflow {
        crate::workflow_credit::save_response(root, local_task_id, &result).map_err(|error| crate::workflow_credit::error(&error))?;
    }
    Ok(result)
}

pub async fn text_completion(operation: &str, payload: Value) -> Result<Value, String> {
    generate_request("", None, Some("TEXT_GENERATION"), &uuid::Uuid::new_v4().to_string(), payload, operation, None).await
}

pub async fn confirmed_quote(api_base: &str, provider_model_id: Option<&str>, capability: Option<&str>, payload: &Value, operation: &str) -> Result<Value, String> {
    crate::credit_confirmation::confirm(operation, quote(api_base,provider_model_id,capability,payload).await?).await
}

pub async fn quote(api_base: &str, provider_model_id: Option<&str>, capability: Option<&str>, payload: &Value) -> Result<Value, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法创建平台 API 客户端：{error}"))?;
    let base = api_base_url(api_base)?;
    let token = crate::platform_session::valid_access_token(&base).await?;
    request_quote_authenticated(
        &client,
        &base,
        &token,
        provider_model_id,
        capability,
        payload,
    )
    .await
}

pub async fn approve_workflow_quote(api_base: &str, items: Value) -> Result<Value, String> {
    authenticated_json_request(api_base, "/tasks/workflow-quotes", json!({"items": items})).await
}

pub async fn recommended_video_concurrency(api_base: &str) -> Result<usize, String> {
    let client = Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(20)).build()
        .map_err(|error| format!("无法创建平台配置客户端：{error}"))?;
    let base = api_base_url(api_base)?;
    let value = response_value(client.get(format!("{base}/client-config/bootstrap")).send().await
        .map_err(|error|format!("无法读取平台并发配置：{error}"))?).await?;
    value["recommended_video_concurrency"].as_u64().and_then(|value|usize::try_from(value).ok())
        .ok_or_else(||"平台没有返回有效的视频并发配置".to_owned())
}

pub async fn stop_workflow_quote(api_base: &str, approval_id: &str) -> Result<(), String> {
    let path = format!("/tasks/workflow-quotes/{approval_id}/stop");
    authenticated_json_request(api_base, &path, json!({})).await.map(|_| ())
}

async fn authenticated_json_request(api_base: &str, path: &str, body: Value) -> Result<Value, String> {
    let client = Client::builder().connect_timeout(Duration::from_secs(30)).timeout(QUOTE_REQUEST_TIMEOUT).build()
        .map_err(|error| format!("无法创建平台 API 客户端：{error}"))?;
    let base = api_base_url(api_base)?;
    let mut token = crate::platform_session::valid_access_token(&base).await?;
    let send = |access_token: &str| client.post(format!("{base}{path}")).bearer_auth(access_token).json(&body).send();
    let mut response = send(&token).await.map_err(|error| format!("无法连接平台 API：{error}"));
    if response.as_ref().ok().is_some_and(|value| value.status() == StatusCode::UNAUTHORIZED) {
        token = crate::platform_session::refresh_after_unauthorized(&base, &token).await?;
        response = send(&token).await.map_err(|error| format!("无法连接平台 API：{error}"));
    }
    response_value(response?).await
}

fn login_required(error: &str) -> bool {
    serde_json::from_str::<Value>(error).ok().is_some_and(|value| value["code"] == "PLATFORM_LOGIN_REQUIRED")
}

async fn request_quote_authenticated(
    client: &Client,
    base: &str,
    token: &str,
    provider_model_id: Option<&str>,
    capability: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    match request_quote(client, base, token, provider_model_id, capability, payload).await {
        Err(error) if login_required(&error) => {
            let refreshed = crate::platform_session::refresh_after_unauthorized(base, token).await?;
            request_quote(client, base, &refreshed, provider_model_id, capability, payload).await
        }
        result => result,
    }
}

fn retryable_quote_status(status: StatusCode) -> bool {
    status.is_server_error()
        || status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
}

async fn quote_retry_delay(attempt: usize) {
    #[cfg(not(test))]
    tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
    #[cfg(test)]
    {
        let _ = attempt;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

async fn request_quote(
    client: &Client,
    base: &str,
    token: &str,
    provider_model_id: Option<&str>,
    capability: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let request_body = json!({
        "provider_model_id": provider_model_id,
        "capability": capability,
        "payload": {
            "resolution": payload.get("resolution"),
            "seconds": payload.get("seconds"),
            "duration": payload.get("duration"),
            "params": payload.get("params"),
        },
    });

    for attempt in 1..=QUOTE_MAX_ATTEMPTS {
        match client
            .post(format!("{base}/tasks/quote"))
            .bearer_auth(token)
            .json(&request_body)
            .timeout(QUOTE_REQUEST_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                let result = response_value(response).await;
                let retryable = status.is_success() || retryable_quote_status(status);
                if result.is_ok() || !retryable || attempt == QUOTE_MAX_ATTEMPTS {
                    return result;
                }
                crate::logging::error(
                    "ai.media.quote_retry",
                    json!({
                        "attempt": attempt,
                        "reason": "response",
                        "status": status.as_u16(),
                        "error": result.unwrap_err(),
                    }),
                );
            }
            Err(error) => {
                crate::logging::error(
                    "ai.media.quote_retry",
                    json!({"attempt": attempt, "reason": "transport", "error": error.to_string()}),
                );
                if attempt == QUOTE_MAX_ATTEMPTS {
                    return Err("暂时查不到所需积分，请稍后再试。本次没有开始，不扣分。".to_owned());
                }
            }
        }
        quote_retry_delay(attempt).await;
    }

    unreachable!("quote retry loop always returns on its final attempt")
}

async fn generate_request(api_base: &str, provider_model_id: Option<&str>, capability: Option<&str>, local_task_id: &str, payload: Value, operation: &str, workflow: Option<(&std::path::Path, &str, String)>) -> Result<Value, String> {
    let client = Client::builder().connect_timeout(Duration::from_secs(30)).timeout(Duration::from_secs(15 * 60)).build().map_err(|error| format!("无法创建平台 API 客户端：{error}"))?;
    let base = api_base_url(api_base)?;
    crate::platform_session::valid_access_token(&base).await?;
    // Keep the approved account's token paired with its identity. Switching
    // accounts after reservation must never charge the newly signed-in user.
    let workflow_session = if workflow.is_some() { Some(read_platform_session()?.ok_or_else(||crate::workflow_credit::error("请先登录后再开始自动制作。"))?) } else { None };
    if let Some((root, _, _)) = &workflow {
        if let Some(receipt) = crate::workflow_credit::receipt(root, local_task_id, &base)? {
            if let Some(response) = receipt.response { return Ok(response); }
            let token = &workflow_session.as_ref().unwrap().access_token;
            let task = recover_request(&client, &base, token, &receipt.request_id).await?;
            let result = wait_for_result(&client, &base, token, task, &workflow, local_task_id).await?;
            crate::workflow_credit::save_response(root, local_task_id, &result).map_err(|e| crate::workflow_credit::error(&e))?;
            return Ok(result);
        }
    }
    let mut workflow_lock: Option<crate::workflow_credit::WorkflowReservation> = None;
    let quote = if let Some((root, id, key)) = &workflow {
        let user = crate::platform_session::current_user_id()?;
        if workflow_session.as_ref().and_then(|session|session.user_id.as_deref()) != Some(user.as_str()) { return Err(crate::workflow_credit::error("账户已切换，自动制作已停止。")); }
        let resolution = payload.get("resolution").or_else(|| payload.pointer("/params/resolution")).and_then(Value::as_str).unwrap_or("");
        let seconds = payload.get("seconds").or_else(||payload.get("duration")).or_else(||payload.pointer("/params/seconds")).or_else(||payload.pointer("/params/duration")).and_then(Value::as_f64);
        if let Some(reservation) = crate::workflow_credit::reserve_locked(root,id,key,provider_model_id.unwrap_or(""),
            capability.unwrap_or_else(|| if seconds.is_some() { "VIDEO_GENERATION" } else { "IMAGE_GENERATION" }),resolution,seconds,local_task_id)? {
            let value = json!({"provider_model_id":provider_model_id,"capability": if seconds.is_some(){"VIDEO_GENERATION"}else{"IMAGE_GENERATION"},
                "resolution":resolution,"seconds":seconds,"credits":reservation.credits});
            workflow_lock = Some(reservation); value
        } else {
            let value = request_quote_authenticated(&client,&base,&workflow_session.as_ref().unwrap().access_token,
                provider_model_id,capability,&payload).await.map_err(|e|crate::workflow_credit::error(&e))?;
            crate::workflow_credit::reserve_legacy(root,id,key,&value,local_task_id)?;
            value
        }
    } else { confirmed_quote(&base, provider_model_id, capability, &payload, operation).await? };
    let mut token = if let Some(session)=workflow_session { session.access_token } else { crate::platform_session::valid_access_token(&base).await? };
    let request_id = uuid::Uuid::new_v4().to_string();
    if let Some((root, _, _)) = &workflow {
        crate::workflow_credit::begin_request(root, local_task_id, &base, &request_id)?;
    }
    let request_body = json!({
        "local_task_id": request_id,
        "idempotency_key": format!("desktop-media-{local_task_id}"),
        "provider_model_id": quote["provider_model_id"],
        "expected_credits": quote["credits"],
        "workflow_quote_approval_id": workflow_lock.as_ref().map(|lock| lock.approval_id.as_str()),
        "workflow_quote_item_key": workflow_lock.as_ref().map(|lock| lock.item_key.as_str()),
        "payload": payload,
    });
    let sent = client.post(format!("{base}/tasks")).bearer_auth(&token).json(&request_body).send().await;
    let mut response = match sent { Ok(response) => response_value(response).await, Err(e) => Err(format!("无法连接服务端生成接口：{e}")) };
    if response.as_ref().err().is_some_and(|error| login_required(error)) {
        token = crate::platform_session::refresh_after_unauthorized(&base, &token).await?;
        response = match client.post(format!("{base}/tasks")).bearer_auth(&token).json(&request_body).send().await {
            Ok(response) => response_value(response).await,
            Err(error) => Err(format!("无法连接服务端生成接口：{error}")),
        };
    }
    let created = match response {
        Ok(value) => value,
        Err(e) => {
            if let Some((root,id,key)) = &workflow {
                crate::logging::error("ai.media.submission_failed", json!({"task_id":local_task_id,"request_id":request_id,"error":e}));
                // Only the server's explicit pre-submission rejection can free
                // this slot without a failed task + confirmed refund. A 404
                // lookup or generic HTTP/network error is not such proof.
                let failure = serde_json::from_str::<Value>(&e).unwrap_or(Value::Null);
                if failure["code"] == "TASK_NOT_SUBMITTED" && failure["retryable"].is_boolean() {
                    crate::workflow_credit::release(root,id,key,local_task_id)?;
                    if failure["retryable"] == false {
                        return Err(crate::workflow_credit::error(failure["message"].as_str().unwrap_or("所选方案暂时无法使用，请重新选择。本次没有扣分。")));
                    }
                    return Err(e);
                }
                recover_request(&client, &base, &token, &request_id).await?
            } else {
                return Err(e);
            }
        }
    };
    let result = wait_for_result(&client, &base, &token, created, &workflow, local_task_id).await?;
    if let Some((root, _, _)) = &workflow {
        crate::workflow_credit::save_response(root, local_task_id, &result).map_err(|e| crate::workflow_credit::error(&e))?;
    }
    Ok(result)
}

async fn recover_request(client: &Client, base: &str, token: &str, request_id: &str) -> Result<Value, String> {
    for _ in 0..5 {
        if let Ok(response) = client.get(format!("{base}/tasks/by-local/{request_id}")).bearer_auth(token).send().await {
            if let Ok(task) = response_value(response).await { return Ok(json!({"task": task})); }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(crate::workflow_credit::error("暂时查不到已提交任务的结果，自动制作已停止，不会重新提交或重复扣分。"))
}

async fn wait_for_result(client: &Client, base: &str, token: &str, mut current: Value,
    workflow: &Option<(&std::path::Path, &str, String)>, local_task_id: &str) -> Result<Value, String> {
    let uncertain = |message: &str| if workflow.is_some() { crate::workflow_credit::error(message) } else { message.to_owned() };
    let mut active_token = token.to_owned();
    let mut errors = 0;
    let mut missing_result = false;
    // A submitted video may legitimately queue for hours. The original task
    // remains the only source of truth; elapsed time is not a failed task.
    loop {
        match task_status(&current) {
            "SUCCEEDED" => {
                if let Some(result) = current.get("provider_response").filter(|v| !v.is_null()) { return Ok(result.clone()); }
                if missing_result { return Err(uncertain("任务已经完成，但暂时取不到结果。已停止后续制作，不会重新生成或重复扣分。")); }
                missing_result = true;
            }
            "FAILED" | "CANCELED" => {
                if let Some((root,id,key)) = workflow { verify_refund(client,base,&active_token,&current).await?; crate::workflow_credit::release(root,id,key,local_task_id)?; }
                return Err(current.pointer("/task/error_code").and_then(Value::as_str).unwrap_or("服务端生成任务失败").to_owned());
            },
            _ => {}
        }
        let task_id = current.pointer("/task/id").and_then(Value::as_str).ok_or_else(|| uncertain("暂时无法确认任务编号，已停止后续制作，不会重新扣分。"))?;
        #[cfg(not(test))]
        tokio::time::sleep(Duration::from_secs((5 + errors * 5).min(30))).await;
        #[cfg(test)]
        tokio::time::sleep(Duration::from_millis(1)).await;
        let mut queried = match client.post(format!("{base}/tasks/{task_id}/query")).bearer_auth(&active_token).send().await {
            Ok(response) => response_value(response).await,
            Err(e) => Err(e.to_string()),
        };
        if queried.as_ref().err().is_some_and(|error| login_required(error)) {
            #[cfg(not(test))]
            match crate::platform_session::refresh_after_unauthorized(base, &active_token).await {
                Ok(refreshed) => {
                    active_token = refreshed;
                    queried = match client.post(format!("{base}/tasks/{task_id}/query")).bearer_auth(&active_token).send().await {
                        Ok(response) => response_value(response).await,
                        Err(error) => Err(error.to_string()),
                    };
                }
                Err(error) => queried = Err(error),
            }
        }
        match queried {
            Ok(value) => { current = value; errors = 0; },
            Err(e) => {
                let failure = serde_json::from_str::<Value>(&e).unwrap_or(Value::Null);
                if failure["code"] == "PLATFORM_LOGIN_REQUIRED" {
                    let login_error = json!({
                        "code": "PLATFORM_LOGIN_REQUIRED",
                        "message": "登录已过期，请重新登录后继续查询。已提交的任务不会重新生成。",
                        "remote_task_id": task_id,
                        "retryable": true,
                    }).to_string();
                    return Err(uncertain(&login_error));
                }
                errors = (errors + 1).min(5);
                // Retry only the same task's status query, not generation.
                missing_result = false;
            }
        }
    }
}

async fn verify_refund(client: &Client, base: &str, token: &str, result: &Value) -> Result<(),String> {
    let id=result.pointer("/task/id").and_then(Value::as_str).ok_or_else(||crate::workflow_credit::error("暂时无法确认退款，自动制作已停止。"))?;
    let response=client.get(format!("{base}/tasks/{id}")).bearer_auth(token).send().await.map_err(|_|crate::workflow_credit::error("暂时无法确认退款，自动制作已停止。"))?;
    let value=response_value(response).await.map_err(|e|crate::workflow_credit::error(&e))?;
    if value["credits_released"] != true { return Err(crate::workflow_credit::error("退款还未确认，自动制作已停止，不再继续扣分。")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_safe_rejection_allows_a_new_attempt() {
        let explicit: Value = serde_json::from_str(&platform_error(StatusCode::SERVICE_UNAVAILABLE,
            r#"{"code":"TASK_NOT_SUBMITTED","retryable":true,"message":"not started"}"#)).unwrap();
        assert_eq!(explicit["code"], "TASK_NOT_SUBMITTED");
        let invalid: Value = serde_json::from_str(&platform_error(StatusCode::BAD_REQUEST,
            r#"{"code":"TASK_NOT_SUBMITTED","retryable":false,"message":"unsupported resolution, no charge"}"#)).unwrap();
        assert_eq!(invalid["code"], "TASK_NOT_SUBMITTED");
        assert_eq!(invalid["retryable"], false);
        assert_eq!(invalid["message"], "unsupported resolution, no charge");
        for (status, body) in [(StatusCode::NOT_FOUND, r#"{"message":"not found"}"#),
            (StatusCode::INTERNAL_SERVER_ERROR, r#"{"message":"Internal server error"}"#),
            (StatusCode::SERVICE_UNAVAILABLE, r#"{"code":"TASK_NOT_SUBMITTED"}"#)] {
            let value: Value = serde_json::from_str(&platform_error(status,body)).unwrap();
            assert_ne!(value["code"], "TASK_NOT_SUBMITTED");
        }
    }

    // Local HTTP fixture only: asserts that recovery never calls POST /tasks.
    fn fixture(responses: Vec<(&'static str, u16, Value)>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(25);
            for (expected, status, body) in responses {
                let mut stream = loop {
                    if let Ok((stream, _)) = listener.accept() { break stream; }
                    assert!(std::time::Instant::now() < deadline, "missing request: {expected}");
                    std::thread::sleep(Duration::from_millis(5));
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with(expected), "unexpected request: {line}");
                loop { line.clear(); reader.read_line(&mut line).unwrap(); if line == "\r\n" || line.is_empty() { break; } }
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (url, handle)
    }

    #[test]
    fn transient_query_errors_only_poll_the_original_task() {
        let result = json!({"task":{"id":"original","status":"SUCCEEDED"},"provider_response":{"url":"image"}});
        let (base, server) = fixture(vec![
            ("POST /tasks/original/query ", 503, json!({"message":"temporary"})),
            ("POST /tasks/original/query ", 200, result),
        ]);
        let received = tauri::async_runtime::block_on(wait_for_result(&Client::new(), &base, "test", json!({"task":{"id":"original","status":"PROCESSING"}}), &None, "attempt")).unwrap();
        assert_eq!(received["url"], "image");
        server.join().unwrap();
    }

    #[test]
    fn quote_retries_a_transient_server_error_without_submitting_a_task() {
        let expected = json!({"provider_model_id":"model-1","credits":10});
        let (base, server) = fixture(vec![
            ("POST /tasks/quote ", 503, json!({"message":"temporary"})),
            ("POST /tasks/quote ", 200, expected.clone()),
        ]);
        let received = tauri::async_runtime::block_on(request_quote(
            &Client::new(),
            &base,
            "test",
            Some("model-1"),
            None,
            &json!({"duration":10,"resolution":"768p"}),
        ))
        .unwrap();
        assert_eq!(received, expected);
        server.join().unwrap();
    }

    #[test]
    fn quote_does_not_retry_a_business_rejection() {
        let (base, server) = fixture(vec![(
            "POST /tasks/quote ",
            400,
            json!({"message":"unsupported duration"}),
        )]);
        let error = tauri::async_runtime::block_on(request_quote(
            &Client::new(),
            &base,
            "test",
            Some("model-1"),
            None,
            &json!({"duration":7}),
        ))
        .unwrap_err();
        let value: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(value["code"], "PLATFORM_MEDIA_API_ERROR");
        assert_eq!(value["retryable"], false);
        server.join().unwrap();
    }

    #[test]
    fn expired_login_preserves_the_original_remote_task_for_resume() {
        let (base, server) = fixture(vec![(
            "POST /tasks/original/query ",
            401,
            json!({"message":"token expired"}),
        )]);
        let error = tauri::async_runtime::block_on(wait_for_result(
            &Client::new(),
            &base,
            "expired-token",
            json!({"task":{"id":"original","status":"PROCESSING"}}),
            &None,
            "attempt",
        ))
        .unwrap_err();
        let value: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(value["code"], "PLATFORM_LOGIN_REQUIRED");
        assert_eq!(value["remote_task_id"], "original");
        assert_eq!(value["retryable"], true);
        server.join().unwrap();
    }

    #[test]
    fn uncertain_submission_recovers_by_original_local_id() {
        let (base, server) = fixture(vec![("GET /tasks/by-local/request-1 ", 200, json!({"id":"original","status":"PROCESSING"}))]);
        let recovered = tauri::async_runtime::block_on(recover_request(&Client::new(), &base, "test", "request-1")).unwrap();
        assert_eq!(recovered["task"]["id"], "original");
        server.join().unwrap();
    }

    #[test]
    fn long_running_task_keeps_polling_past_old_limit_and_transient_failures() {
        let mut responses = vec![("POST /tasks/original/query ", 200, json!({"task":{"id":"original","status":"PROCESSING"}})); 305];
        responses.extend(vec![("POST /tasks/original/query ", 503, json!({"message":"temporary"})); 6]);
        responses.push(("POST /tasks/original/query ", 200, json!({"task":{"id":"original","status":"SUCCEEDED"},"provider_response":{"url":"video"}})));
        let (base, server) = fixture(responses);
        let received = tauri::async_runtime::block_on(wait_for_result(&Client::new(), &base, "test", json!({"task":{"id":"original","status":"PROCESSING"}}), &None, "attempt")).unwrap();
        assert_eq!(received["url"], "video");
        server.join().unwrap();
    }

    #[test]
    fn completed_task_without_result_stops_without_regeneration() {
        let (base, server) = fixture(vec![("POST /tasks/original/query ", 200, json!({"task":{"id":"original","status":"SUCCEEDED"}}))]);
        let workflow = Some((std::path::Path::new("unused"), "grant", "image:scene:S1".to_owned()));
        let error = tauri::async_runtime::block_on(wait_for_result(&Client::new(), &base, "test", json!({"task":{"id":"original","status":"SUCCEEDED"}}), &workflow, "attempt")).unwrap_err();
        assert!(error.contains("WORKFLOW_CREDIT_STOPPED"));
        server.join().unwrap();
    }

    #[test]
    fn accepts_production_https_and_local_development_urls() {
        assert_eq!(api_base_url("https://ai-studio.yuntianxing.net/api/v1/").unwrap(), PRODUCTION_API_BASE_URL);
        assert_eq!(api_base_url(DEVELOPMENT_API_BASE_URL).unwrap(), DEVELOPMENT_API_BASE_URL);
        assert!(api_base_url("http://example.com/api/v1").is_err());
        assert!(api_base_url("ftp://localhost/api/v1").is_err());
        assert!(refresh_api_base_url("https://untrusted.example/api/v1").is_err());
    }

    #[test]
    fn reads_platform_task_status_without_using_provider_status() {
        assert_eq!(task_status(&json!({"task": {"status": "SUCCEEDED"}, "provider_response": {"status": "processing"}})), "SUCCEEDED");
        assert_eq!(task_status(&json!({})), "");
    }
}
