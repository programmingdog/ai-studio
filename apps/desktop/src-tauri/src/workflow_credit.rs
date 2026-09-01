//! Durable, account/project-scoped approval for exactly the planned media items.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Serialize, Deserialize)]
pub struct BudgetItem {
    pub key: String,
    pub provider_model_id: String,
    pub resolution: String,
    pub seconds: Option<f64>,
    pub credits: f64,
    pub capability: String,
    #[serde(default)]
    used: bool,
    #[serde(default)]
    attempt: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Budget { user: String, active: bool, items: BTreeMap<String, BudgetItem> }
pub fn error(message: &str) -> String { json!({"code":"WORKFLOW_CREDIT_STOPPED", "message":message, "retryable":false}).to_string() }
fn open(root: &Path) -> Result<rusqlite::Connection, String> {
    let connection = crate::database::open(root)?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_credit_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL)").map_err(|e| e.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_media_receipts (
        attempt TEXT PRIMARY KEY, user_id TEXT NOT NULL, api_base TEXT NOT NULL,
        request_id TEXT NOT NULL, response_json TEXT
    )").map_err(|e| e.to_string())?;
    Ok(connection)
}

pub struct MediaReceipt { pub request_id: String, pub response: Option<Value> }

pub fn recoverable_images(root: &Path) -> Result<Vec<String>, String> {
    let connection = open(root)?;
    let mut statement = connection.prepare("SELECT t.id FROM image_generation_tasks t
        JOIN workflow_media_receipts r ON r.attempt=t.id
        WHERE t.status='FAILED' AND r.response_json IS NOT NULL AND r.user_id=?1").map_err(|e| e.to_string())?;
    let rows = statement.query_map([crate::platform_session::current_user_id()?], |row| row.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

pub fn receipt(root: &Path, attempt: &str, api_base: &str) -> Result<Option<MediaReceipt>, String> {
    use rusqlite::OptionalExtension;
    let connection = open(root)?;
    let stored: Option<(String, Option<String>)> = connection.query_row(
        "SELECT request_id,response_json FROM workflow_media_receipts WHERE attempt=?1 AND user_id=?2 AND api_base=?3",
        rusqlite::params![attempt, crate::platform_session::current_user_id()?, api_base],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    stored.map(|(request_id,response)| Ok(MediaReceipt { request_id,
        response: response.map(|raw| serde_json::from_str(&raw)).transpose().map_err(|e| e.to_string())?,
    })).transpose()
}

// Persist the request identity BEFORE sending. Recovery only queries this
// original request; it never resubmits a paid generation under a new ID.
pub fn begin_request(root: &Path, attempt: &str, api_base: &str, request_id: &str) -> Result<(), String> {
    open(root)?.execute("INSERT INTO workflow_media_receipts(attempt,user_id,api_base,request_id) VALUES (?1,?2,?3,?4)",
        rusqlite::params![attempt, crate::platform_session::current_user_id()?, api_base, request_id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_response(root: &Path, attempt: &str, response: &Value) -> Result<(), String> {
    let changed = open(root)?.execute("UPDATE workflow_media_receipts SET response_json=?1 WHERE attempt=?2 AND user_id=?3",
        rusqlite::params![response.to_string(), attempt, crate::platform_session::current_user_id()?]).map_err(|e| e.to_string())?;
    if changed != 1 { return Err(error("生成结果暂时无法保存，已停止后续制作。")); }
    Ok(())
}

// A local save/download error is not proof that the provider failed/refunded.
pub fn failure_message(root: &Path, id: &str, key: &str, attempt: &str, message: &str) -> String {
    if serde_json::from_str::<Value>(message).ok().is_some_and(|value| value["code"] == "WORKFLOW_CREDIT_STOPPED") {
        return message.to_owned();
    }
    let check = update(root, id, |budget| {
        if budget.items.get(key).is_some_and(|item| item.used && item.attempt.as_deref() == Some(attempt)) {
            return Err(error("这张图片的结果还需要确认，自动制作已停止，不会重新生成或重复扣分。"));
        }
        Ok(())
    });
    match check { Ok(()) => message.to_owned(), Err(_) => error("这张图片的结果还需要确认，自动制作已停止，不会重新生成或重复扣分。") }
}

#[tauri::command]
pub async fn approve_workflow_credit(project_path: String, items: Vec<BudgetItem>, api_base: String) -> Result<String, String> {
    let user = crate::platform_session::current_user_id()?;
    let mut approved = BTreeMap::new();
    let mut quotes: BTreeMap<String, Value> = BTreeMap::new();
    for mut item in items {
        if item.key.is_empty() || !item.credits.is_finite() || item.credits < 0.0 || !matches!(item.capability.as_str(), "IMAGE_GENERATION" | "VIDEO_GENERATION") { return Err(error("费用信息不完整，请重新开始。")); }
        let cache_key = format!("{}|{}|{:?}", item.provider_model_id, item.resolution, item.seconds);
        let quote = if let Some(value) = quotes.get(&cache_key) { value.clone() } else {
            let value = crate::platform_media::quote(&api_base, Some(&item.provider_model_id), None, &json!({"resolution":item.resolution,"seconds":item.seconds})).await?;
            quotes.insert(cache_key, value.clone()); value
        };
        validate(&item, &quote)?;
        item.used = false;
        item.attempt = None;
        if approved.insert(item.key.clone(), item).is_some() { return Err(error("生成清单有重复，请重新开始。")); }
    }
    if crate::platform_session::current_user_id()? != user { return Err(error("账户已切换，请重新开始。")); }
    let id = uuid::Uuid::new_v4().to_string();
    let stored_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open(Path::new(&project_path))?;
        let data = serde_json::to_string(&Budget { user, active: true, items: approved }).map_err(|e|e.to_string())?;
        connection.execute("INSERT INTO workflow_credit_approvals(id,data) VALUES (?,?)", rusqlite::params![stored_id, data]).map_err(|e|e.to_string())?;
        Ok::<_,String>(())
    }).await.map_err(|e|e.to_string())??;
    Ok(id)
}
fn validate(item: &BudgetItem, quote: &Value) -> Result<(), String> {
    if quote["provider_model_id"].as_str() != Some(&item.provider_model_id) || quote["capability"].as_str() != Some(&item.capability)
        || quote["resolution"].as_str() != Some(&item.resolution) || quote["seconds"].as_f64() != item.seconds
        || quote["credits"].as_f64() != Some(item.credits) { return Err(error("所需积分或生成内容有变化，自动制作已停止，没有追加扣分。请重新开始。")); }
    Ok(())
}
fn update(root: &Path, id: &str, change: impl FnOnce(&mut Budget) -> Result<(),String>) -> Result<(),String> {
    let mut connection = open(root)?;
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let data: String = tx.query_row("SELECT data FROM workflow_credit_approvals WHERE id=?", [id], |row|row.get(0)).map_err(|_|error("本次自动制作的积分确认已失效，请重新开始。"))?;
    let mut budget: Budget = serde_json::from_str(&data).map_err(|e|e.to_string())?;
    if budget.user != crate::platform_session::current_user_id()? { return Err(error("账户已切换，自动制作已停止。")); }
    change(&mut budget)?;
    tx.execute("UPDATE workflow_credit_approvals SET data=? WHERE id=?", rusqlite::params![serde_json::to_string(&budget).map_err(|e|e.to_string())?, id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
pub fn reserve(root: &Path, id: &str, key: &str, quote: &Value, attempt: &str) -> Result<(),String> {
    update(root,id,|budget| {
        if !budget.active { return Err(error("自动制作已停止，不再扣分。")); }
        let item = budget.items.get_mut(key).ok_or_else(||error("新增内容不在本次确认范围内，自动制作已停止。"))?;
        validate(item,quote)?;
        if item.used && item.attempt.as_deref()!=Some(attempt) { return Err(error("这项内容已经提交，暂时无法确认结果。为避免重复扣分，自动制作已停止。")); }
        item.used = true; item.attempt=Some(attempt.to_owned()); Ok(())
    })
}
pub fn release(root: &Path, id: &str, key: &str, attempt: &str) -> Result<(),String> {
    update(root,id,|budget| { if let Some(item)=budget.items.get_mut(key) { if item.attempt.as_deref()==Some(attempt) { item.used=false; item.attempt=None; } } Ok(()) })
}
#[tauri::command]
pub async fn stop_workflow_credit(project_path: String, id: String) -> Result<(),String> {
    tauri::async_runtime::spawn_blocking(move || update(Path::new(&project_path), &id, |budget| {budget.active=false; Ok(())})).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_receipts_survive_reopen_and_preserve_the_original_request() {
        let (root, _) = setup();
        begin_request(&root, "attempt", "https://example.test", "request-1").unwrap();
        assert!(begin_request(&root, "attempt", "https://example.test", "request-2").is_err());
        let saved = receipt(&root, "attempt", "https://example.test").unwrap().unwrap();
        assert_eq!(saved.request_id, "request-1");
        assert!(saved.response.is_none());
        let response = json!({"data":[{"url":"https://example.test/image.png"}]});
        save_response(&root, "attempt", &response).unwrap();
        assert_eq!(receipt(&root, "attempt", "https://example.test").unwrap().unwrap().response, Some(response));
        assert!(receipt(&root, "attempt", "https://other.test").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_failure_cannot_authorize_another_paid_attempt() {
        let (root, quote) = setup();
        let original = error("暂时查不到原任务，请稍后查看。");
        assert_eq!(failure_message(&root, "grant", "image:scene:S1", "attempt", &original), original);
        assert_eq!(failure_message(&root, "grant", "image:scene:S1", "attempt", "database error"), "database error");
        reserve(&root, "grant", "image:scene:S1", &quote, "attempt").unwrap();
        assert!(failure_message(&root, "grant", "image:scene:S1", "attempt", "database error").contains("WORKFLOW_CREDIT_STOPPED"));
        release(&root, "grant", "image:scene:S1", "attempt").unwrap();
        assert_eq!(failure_message(&root, "grant", "image:scene:S1", "attempt", "refunded"), "refunded");
        std::fs::remove_dir_all(root).unwrap();
    }
    fn setup() -> (std::path::PathBuf,Value) {
        let root=std::env::temp_dir().join(format!("aivs-budget-test-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let item=BudgetItem{key:"image:scene:S1".into(),provider_model_id:"model".into(),resolution:"2K".into(),seconds:None,credits:2.5,capability:"IMAGE_GENERATION".into(),used:false,attempt:None};
        let data=serde_json::to_string(&Budget{user:"test-user".into(),active:true,items:BTreeMap::from([(item.key.clone(),item)])}).unwrap();
        open(&root).unwrap().execute("INSERT INTO workflow_credit_approvals VALUES ('grant',?)",[data]).unwrap();
        (root,json!({"provider_model_id":"model","resolution":"2K","seconds":null,"credits":2.5,"capability":"IMAGE_GENERATION"}))
    }
    #[test]
    fn approval_is_durable_and_prevents_a_second_paid_attempt() {
        let (root,quote)=setup();
        reserve(&root,"grant","image:scene:S1",&quote,"attempt-1").unwrap();
        // Reopening the database preserves the consumed slot. Same idempotency
        // key can recover the original request, never create another charge.
        reserve(&root,"grant","image:scene:S1",&quote,"attempt-1").unwrap();
        assert!(reserve(&root,"grant","image:scene:S1",&quote,"attempt-2").is_err());
        release(&root,"grant","image:scene:S1","attempt-1").unwrap();
        reserve(&root,"grant","image:scene:S1",&quote,"attempt-2").unwrap();
        release(&root,"grant","image:scene:S1","attempt-1").unwrap();
        assert!(reserve(&root,"grant","image:scene:S1",&quote,"attempt-3").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_price_parameters_and_unplanned_items_fail_closed() {
        let (root,quote)=setup();
        for (field,value) in [("credits",json!(2.6)),("resolution",json!("4K")),("provider_model_id",json!("other")),("seconds",json!(5)),("capability",json!("VIDEO_GENERATION"))] {
            let mut changed=quote.clone();changed[field]=value;
            assert!(reserve(&root,"grant","image:scene:S1",&changed,"attempt").is_err());
        }
        assert!(reserve(&root,"grant","image:scene:S2",&quote,"attempt").is_err());
        reserve(&root,"grant","image:scene:S1",&quote,"attempt").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn revoked_other_account_and_other_project_grants_cannot_spend() {
        let (root,quote)=setup();
        update(&root,"grant",|budget|{budget.active=false;Ok(())}).unwrap();
        assert!(reserve(&root,"grant","image:scene:S1",&quote,"a").is_err());
        update(&root,"grant",|budget|{budget.active=true;budget.user="another-user".into();Ok(())}).unwrap();
        assert!(reserve(&root,"grant","image:scene:S1",&quote,"a").is_err());
        let other=std::env::temp_dir().join(format!("aivs-budget-test-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        assert!(reserve(&other,"grant","image:scene:S1",&quote,"a").is_err());
        std::fs::remove_dir_all(root).unwrap();std::fs::remove_dir_all(other).unwrap();
    }
}
