//! Every paid native request waits for an explicit, account-bound UI decision.
//! Polling exposes pending confirmations even after a webview reload; no event
//! can be missed and no approval survives a process restart.
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::{Mutex, OnceLock}, time::Duration};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
pub struct Confirmation {
    pub id: String,
    pub operation: String,
    pub quote: Value,
    #[serde(skip)]
    user_id: String,
}
struct Pending { view: Confirmation, sender: oneshot::Sender<bool> }
static PENDING: OnceLock<Mutex<BTreeMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<BTreeMap<String, Pending>> { PENDING.get_or_init(|| Mutex::new(BTreeMap::new())) }
pub fn cancelled(message: &str) -> String {
    json!({"code":"CREDIT_CONFIRMATION_CANCELLED", "message":message, "retryable":false}).to_string()
}

pub async fn confirm(operation: &str, quote: Value) -> Result<Value, String> {
    let credits = quote.get("credits").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| "暂时查不到所需积分，请稍后再试。本次没有开始，不扣分。".to_owned())?;
    let _ = credits; // Free configured models still receive an explicit 0-credit notice.
    let user_id = crate::platform_session::current_user_id()?;
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let view = Confirmation { id: id.clone(), operation: operation.to_owned(), quote: quote.clone(), user_id: user_id.clone() };
    pending().lock().map_err(|_| "积分确认队列不可用")?.insert(id.clone(), Pending { view, sender });
    let approved = tokio::time::timeout(Duration::from_secs(15 * 60), receiver).await;
    pending().lock().map_err(|_| "积分确认队列不可用")?.remove(&id);
    if !matches!(approved, Ok(Ok(true))) { return Err(cancelled("已取消或超时，本次没有开始，不扣积分。")); }
    if crate::platform_session::current_user_id()? != user_id { return Err(cancelled("账户已切换，请重新确认积分费用")); }
    Ok(quote)
}

#[tauri::command]
pub async fn list_credit_confirmations() -> Result<Vec<Confirmation>, String> {
    tauri::async_runtime::spawn_blocking(list_pending).await.map_err(|error| error.to_string())?
}

fn list_pending() -> Result<Vec<Confirmation>, String> {
    let user = crate::platform_session::current_user_id().ok();
    let mut queue = pending().lock().map_err(|_| "积分确认队列不可用")?;
    // Dropping another account's sender safely cancels its waiting request.
    queue.retain(|_, p| user.as_deref() == Some(p.view.user_id.as_str()) && !p.sender.is_closed());
    Ok(queue.values().map(|p| p.view.clone()).collect())
}

#[tauri::command]
pub async fn resolve_credit_confirmation(id: String, approved: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resolve_pending(id, approved)).await.map_err(|error| error.to_string())?
}

fn resolve_pending(id: String, approved: bool) -> Result<(), String> {
    let user = crate::platform_session::current_user_id()?;
    let mut queue = pending().lock().map_err(|_| "积分确认队列不可用")?;
    if let Some(item) = queue.get(&id) {
        if item.view.user_id != user { return Err("不能确认其他账户的费用".into()); }
    }
    if let Some(item) = queue.remove(&id) { let _ = item.sender.send(approved); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_not_retryable() {
        let value: Value = serde_json::from_str(&cancelled("取消")).unwrap();
        assert_eq!(value["retryable"], false);
        assert_eq!(value["code"], "CREDIT_CONFIRMATION_CANCELLED");
    }

    #[test]
    fn requests_wait_for_explicit_approval_and_cancellation_never_approves() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            assert!(confirm("无效报价", json!({"credits": -1})).await.is_err());
            assert!(list_pending().unwrap().is_empty());
            for approved in [true, false] {
                let task = tokio::spawn(confirm("二创测试", json!({"credits": 1.25, "model_alias": "测试模型"})));
                tokio::task::yield_now().await;
                assert!(!task.is_finished());
                let queue = list_pending().unwrap();
                assert_eq!(queue.len(), 1);
                assert_eq!(queue[0].quote["credits"], 1.25);
                resolve_pending(queue[0].id.clone(), approved).unwrap();
                assert_eq!(task.await.unwrap().is_ok(), approved);
                assert!(list_pending().unwrap().is_empty());
            }
        });
    }
}
