use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::Manager;

static LOG_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static LOG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const MAX_LOG_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub enum LogLevel {
    Error,
    Info,
    Debug,
    Critical,
}

impl LogLevel {
    fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Critical => "critical",
        }
    }
}

pub fn init(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join("logs");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建日志目录：{error}"))?;
    for level in [
        LogLevel::Error,
        LogLevel::Info,
        LogLevel::Debug,
        LogLevel::Critical,
    ] {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join(format!("{}.log", level.name())))
            .map_err(|error| format!("无法创建 {} 日志文件：{error}", level.name()))?;
    }
    let _ = LOG_DIRECTORY.set(directory.clone());
    info(
        "application.logging.initialized",
        json!({"log_directory": directory.to_string_lossy()}),
    );
    Ok(directory)
}

pub fn directory() -> Option<&'static Path> {
    LOG_DIRECTORY.get().map(PathBuf::as_path)
}

pub fn log(level: LogLevel, event: &str, details: Value) {
    let Some(directory) = directory() else {
        return;
    };
    let Ok(_guard) = LOG_WRITE_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(format!("{}.log", level.name())))
    else {
        return;
    };
    let entry = json!({
        "timestamp": Local::now().to_rfc3339(),
        "level": level.name(),
        "event": event,
        "details": details,
    });
    let _ = writeln!(file, "{entry}");
}

pub fn debug(event: &str, details: Value) {
    log(LogLevel::Debug, event, details);
}

pub fn info(event: &str, details: Value) {
    log(LogLevel::Info, event, details);
}

pub fn error(event: &str, details: Value) {
    log(LogLevel::Error, event, details);
}

#[allow(dead_code)]
pub fn critical(event: &str, details: Value) {
    log(LogLevel::Critical, event, details);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    timestamp: String,
    level: String,
    event: String,
    details: Value,
}

#[derive(Debug, Serialize)]
pub struct LogListResult {
    directory: String,
    entries: Vec<LogEntry>,
    truncated: bool,
}

fn recent_entries(path: &Path, limit: usize) -> Result<(Vec<LogEntry>, bool), String> {
    let mut file = File::open(path).map_err(|error| format!("无法打开日志文件：{error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("无法读取日志文件信息：{error}"))?
        .len();
    let start = length.saturating_sub(MAX_LOG_READ_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("无法定位日志文件：{error}"))?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| format!("无法读取日志文件：{error}"))?;
    if start > 0 {
        if let Some(newline) = content.find('\n') {
            content.drain(..=newline);
        } else {
            content.clear();
        }
    }
    let mut entries = content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<LogEntry>(line).ok())
        .take(limit + 1)
        .collect::<Vec<_>>();
    let truncated = start > 0 || entries.len() > limit;
    entries.truncate(limit);
    Ok((entries, truncated))
}

fn entries_in_range(
    path: &Path,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    limit: usize,
) -> Result<(Vec<LogEntry>, bool), String> {
    let file = File::open(path).map_err(|error| format!("无法打开日志文件：{error}"))?;
    let mut entries = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<LogEntry>(&line).ok())
        .filter(|entry| {
            let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) else {
                return false;
            };
            let timestamp = timestamp.with_timezone(&Utc);
            start.is_none_or(|value| timestamp >= value)
                && end.is_none_or(|value| timestamp <= value)
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok((entries, truncated))
}

fn parse_time_boundary(
    value: Option<String>,
    label: &str,
) -> Result<Option<DateTime<Utc>>, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|timestamp| timestamp.with_timezone(&Utc))
                .map_err(|_| format!("{label}格式无效"))
        })
        .transpose()
}

#[tauri::command]
pub async fn list_application_logs(
    level: Option<String>,
    limit: Option<usize>,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<LogListResult, String> {
    crate::background::run("读取应用日志", move || {
        list_application_logs_blocking(level, limit, start_time, end_time)
    })
    .await
}

fn list_application_logs_blocking(
    level: Option<String>,
    limit: Option<usize>,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<LogListResult, String> {
    let directory = directory().ok_or_else(|| "日志系统尚未初始化".to_owned())?;
    let requested_level = level.unwrap_or_else(|| "all".into()).to_ascii_lowercase();
    if !matches!(
        requested_level.as_str(),
        "all" | "error" | "info" | "debug" | "critical"
    ) {
        return Err("日志等级无效".into());
    }
    let limit = limit.unwrap_or(500).clamp(1, 100_000);
    let start_time = parse_time_boundary(start_time, "开始时间")?;
    let end_time = parse_time_boundary(end_time, "结束时间")?;
    if start_time
        .zip(end_time)
        .is_some_and(|(start, end)| start > end)
    {
        return Err("开始时间不能晚于结束时间".into());
    }
    let has_time_range = start_time.is_some() || end_time.is_some();
    let levels = if requested_level == "all" {
        vec!["critical", "error", "info", "debug"]
    } else {
        vec![requested_level.as_str()]
    };
    let mut entries = Vec::new();
    let mut truncated = false;
    for level in levels {
        let path = directory.join(format!("{level}.log"));
        let (mut level_entries, level_truncated) = if has_time_range {
            entries_in_range(&path, start_time, end_time, limit)?
        } else {
            recent_entries(&path, limit)?
        };
        entries.append(&mut level_entries);
        truncated |= level_truncated;
    }
    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    if entries.len() > limit {
        entries.truncate(limit);
        truncated = true;
    }
    Ok(LogListResult {
        directory: directory.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_all_required_log_level_names() {
        assert_eq!(LogLevel::Error.name(), "error");
        assert_eq!(LogLevel::Info.name(), "info");
        assert_eq!(LogLevel::Debug.name(), "debug");
        assert_eq!(LogLevel::Critical.name(), "critical");
    }

    #[test]
    fn parses_recent_json_log_entries() {
        let path = std::env::temp_dir().join(format!("aivs-log-{}.log", uuid::Uuid::new_v4()));
        fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-08-22T20:00:00+08:00\",\"level\":\"info\",\"event\":\"first\",\"details\":{}}\n",
                "{\"timestamp\":\"2026-08-22T20:01:00+08:00\",\"level\":\"info\",\"event\":\"second\",\"details\":{}}\n"
            ),
        )
        .unwrap();
        let (entries, truncated) = recent_entries(&path, 1).unwrap();
        assert_eq!(entries[0].event, "second");
        assert!(truncated);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn filters_log_entries_by_inclusive_time_range() {
        let path =
            std::env::temp_dir().join(format!("aivs-log-range-{}.log", uuid::Uuid::new_v4()));
        fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-08-22T20:00:00+08:00\",\"level\":\"info\",\"event\":\"before\",\"details\":{}}\n",
                "{\"timestamp\":\"2026-08-22T20:30:00+08:00\",\"level\":\"info\",\"event\":\"inside\",\"details\":{}}\n",
                "{\"timestamp\":\"2026-08-22T21:00:00+08:00\",\"level\":\"info\",\"event\":\"after\",\"details\":{}}\n"
            ),
        )
        .unwrap();
        let start = DateTime::parse_from_rfc3339("2026-08-22T20:15:00+08:00")
            .unwrap()
            .with_timezone(&Utc);
        let end = DateTime::parse_from_rfc3339("2026-08-22T20:45:00+08:00")
            .unwrap()
            .with_timezone(&Utc);
        let (entries, truncated) = entries_in_range(&path, Some(start), Some(end), 10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event, "inside");
        assert!(!truncated);
        let _ = fs::remove_file(path);
    }
}
