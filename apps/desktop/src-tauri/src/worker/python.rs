use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub enum WorkerEvent {
    Progress {
        value: f64,
        stage: String,
        message: String,
    },
    Result(Value),
    Error(Value),
}

pub fn develop_idea(idea: &str, creation_spec: &Value) -> Result<Vec<WorkerEvent>, String> {
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let request = json!({
        "version": "1.0", "id": request_id, "type": "request",
        "method": "workflow.develop_idea",
        "params": {"idea": idea, "creation_spec": creation_spec}
    });
    call_worker(&request)
}

pub fn analyze_script(
    script_text: Option<&str>,
    script_path: Option<&Path>,
    creation_spec: &Value,
) -> Result<Vec<WorkerEvent>, String> {
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let request = json!({
        "version": "1.0", "id": request_id, "type": "request",
        "method": "workflow.analyze_script",
        "params": {
            "script_text": script_text,
            "script_path": script_path.map(|path| path.to_string_lossy().to_string()),
            "creation_spec": creation_spec
        }
    });
    call_worker(&request)
}

pub fn resolve_douyin(
    share_text: &str,
    browser_cookie_source: Option<&str>,
    cookie_file_path: Option<&str>,
) -> Result<Vec<WorkerEvent>, String> {
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let request = json!({
        "version": "1.0", "id": request_id, "type": "request",
        "method": "input.resolve_douyin",
        "params": {
            "share_text": share_text,
            "browser_cookie_source": browser_cookie_source,
            "cookie_file_path": cookie_file_path
        }
    });
    call_worker(&request)
}

pub fn resolve_douyin_auto(
    share_text: &str,
    profile_root: &Path,
) -> Result<Vec<WorkerEvent>, String> {
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let request = json!({
        "version": "1.0", "id": request_id, "type": "request",
        "method": "input.resolve_douyin_auto",
        "params": {
            "share_text": share_text,
            "profile_root": profile_root.to_string_lossy().to_string()
        }
    });
    call_worker(&request)
}

pub fn douyin_browser_availability() -> Result<Vec<WorkerEvent>, String> {
    let request = json!({
        "version": "1.0", "id": format!("req_{}", uuid::Uuid::new_v4().simple()), "type": "request",
        "method": "input.douyin_browser_availability",
        "params": {}
    });
    call_worker(&request)
}

pub fn download_douyin(
    share_text: &str,
    output_path: &Path,
    browser_cookie_source: Option<&str>,
    cookie_file_path: Option<&str>,
) -> Result<Vec<WorkerEvent>, String> {
    let request = json!({
        "version": "1.0", "id": format!("req_{}", uuid::Uuid::new_v4().simple()), "type": "request",
        "method": "input.download_douyin",
        "params": {
            "share_text": share_text,
            "output_path": output_path.to_string_lossy().to_string(),
            "browser_cookie_source": browser_cookie_source,
            "cookie_file_path": cookie_file_path
        }
    });
    call_worker(&request)
}

pub fn download_douyin_auto(
    share_text: &str,
    output_path: &Path,
    profile_root: &Path,
) -> Result<Vec<WorkerEvent>, String> {
    let request = json!({
        "version": "1.0", "id": format!("req_{}", uuid::Uuid::new_v4().simple()), "type": "request",
        "method": "input.download_douyin_auto",
        "params": {
            "share_text": share_text,
            "output_path": output_path.to_string_lossy().to_string(),
            "profile_root": profile_root.to_string_lossy().to_string()
        }
    });
    call_worker(&request)
}

fn call_worker(request: &Value) -> Result<Vec<WorkerEvent>, String> {
    let (mut command, worker_path) = worker_command()?;
    if let Ok(yt_dlp) = crate::media_tools::resolve("yt-dlp", "AIVS_YTDLP_PATH") {
        command.env("AIVS_YTDLP_PATH", yt_dlp);
    }
    let mut child = command
        .current_dir(worker_path.parent().unwrap_or(Path::new(".")))
        // The JSONL protocol is UTF-8 on every platform. These variables also
        // cover errors emitted before the worker can reconfigure its streams.
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to start AI worker {}: {error}",
                worker_path.display()
            )
        })?;
    let mut stdin = child.stdin.take().ok_or("worker stdin unavailable")?;
    writeln!(stdin, "{}", request).map_err(|error| error.to_string())?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or("worker stdout unavailable")?;
    let mut events = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let message: Value = serde_json::from_str(&line.map_err(|error| error.to_string())?)
            .map_err(|error| format!("invalid worker response: {error}"))?;
        match message.get("type").and_then(Value::as_str) {
            Some("progress") => events.push(WorkerEvent::Progress {
                value: message
                    .get("progress")
                    .and_then(Value::as_f64)
                    .unwrap_or_default(),
                stage: message
                    .get("stage")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                message: message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }),
            Some("result") => events.push(WorkerEvent::Result(
                message.get("data").cloned().unwrap_or(Value::Null),
            )),
            Some("error") => events.push(WorkerEvent::Error(
                message.get("error").cloned().unwrap_or(Value::Null),
            )),
            _ => return Err("unknown worker message type".into()),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Python worker exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(events)
}

fn worker_command() -> Result<(Command, PathBuf), String> {
    if let Ok(path) = std::env::var("AIVS_WORKER_PATH") {
        return command_for_worker_path(PathBuf::from(path));
    }
    if let Ok(path) = crate::media_tools::resolve("aivs-worker", "AIVS_WORKER_PATH") {
        return Ok((Command::new(&path), path));
    }
    command_for_worker_path(worker_script_path())
}

fn command_for_worker_path(path: PathBuf) -> Result<(Command, PathBuf), String> {
    if !path.is_file() {
        return Err(format!("AI Worker 不存在：{}", path.display()));
    }
    if path.extension().and_then(|value| value.to_str()) == Some("py") {
        let python = std::env::var("AIVS_PYTHON").unwrap_or_else(|_| {
            if cfg!(target_os = "windows") {
                "python".to_owned()
            } else {
                "python3".to_owned()
            }
        });
        let mut command = Command::new(python);
        command.arg(&path);
        Ok((command, path))
    } else {
        Ok((Command::new(&path), path))
    }
}

fn worker_script_path() -> PathBuf {
    if let Ok(path) = std::env::var("AIVS_WORKER_PATH") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../python-engine/main.py")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_round_trip_preserves_chinese() {
        let creation_spec = json!({
            "project_name": "齐天一小时",
            "target_duration": 60
        });
        let events = develop_idea(
            "一个外卖员获得孙悟空能力，每天只能变身一个小时。",
            &creation_spec,
        )
        .expect("Chinese JSONL should be valid UTF-8");

        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Progress { message, .. } if message.contains("正在")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Result(value) if value["story"]["title"] == "齐天一小时"
        )));
    }

    #[test]
    fn script_worker_extracts_original_characters() {
        let creation_spec = json!({"project_name": "剧本项目", "target_duration": 60});
        let events = analyze_script(
            Some("第一场 外景 雨夜\n林小凡：我一定会回来。\n周晴：我等你。"),
            None,
            &creation_spec,
        )
        .expect("script workflow should complete");
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Result(value) if value["characters"][0]["name"] == "林小凡"
        )));
    }

    #[test]
    fn douyin_worker_rejects_untrusted_domains() {
        let events = resolve_douyin("https://example.com/video/1", None, None)
            .expect("worker should return a protocol error");
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Error(value) if value["code"] == "DOUYIN_DOMAIN_NOT_ALLOWED"
        )));
    }

    #[test]
    fn douyin_worker_rejects_unapproved_cookie_browser() {
        let events = resolve_douyin(
            "https://www.douyin.com/video/123",
            Some("unknown-browser"),
            None,
        )
        .expect("worker should validate the cookie source before accessing the network");
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Error(value) if value["code"] == "DOUYIN_COOKIE_BROWSER_NOT_ALLOWED"
        )));
    }
}
