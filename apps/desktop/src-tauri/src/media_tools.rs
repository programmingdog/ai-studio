use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn executable_name(tool: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{tool}.exe")
    } else {
        tool.to_owned()
    }
}

pub fn resolve(tool: &str, override_environment: &str) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var(override_environment) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "环境变量 {override_environment} 指向的工具不存在：{}",
            path.display()
        ));
    }

    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位应用程序目录：{error}"))?;
    let parent = executable
        .parent()
        .ok_or_else(|| "无法定位应用程序目录".to_owned())?;
    let filename = executable_name(tool);
    let mut candidates = vec![parent.join(&filename)];
    // Rust test binaries live under target/{profile}/deps while Tauri sidecars
    // are copied to target/{profile}. This candidate also helps local tooling.
    if let Some(profile_dir) = parent.parent() {
        candidates.push(profile_dir.join(&filename));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("应用安装包缺少内置 {tool}。请重新安装完整版本，或联系软件供应方。"))
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalVideoMetadata {
    pub duration: f64,
    pub width: u64,
    pub height: u64,
    pub aspect_ratio: String,
    pub size_bytes: u64,
}

fn metadata_error(code: &str, message: impl Into<String>) -> String {
    json!({"code": code, "message": message.into(), "retryable": false}).to_string()
}

fn numeric_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

pub fn probe_video_metadata(path: &Path) -> Result<LocalVideoMetadata, String> {
    let file = std::fs::metadata(path).map_err(|error| {
        metadata_error("VIDEO_READ_ERROR", format!("无法读取本地视频：{error}"))
    })?;
    if !file.is_file() || file.len() == 0 {
        return Err(metadata_error(
            "VIDEO_FILE_INVALID",
            "所选视频文件为空或无效",
        ));
    }
    let ffprobe = resolve("ffprobe", "AIVS_FFPROBE_PATH")
        .map_err(|message| metadata_error("FFPROBE_NOT_AVAILABLE", message))?;
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type,width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| {
            metadata_error(
                "FFPROBE_NOT_AVAILABLE",
                format!("无法启动 FFprobe 获取视频信息：{error}"),
            )
        })?;
    if !output.status.success() {
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(1_000)
            .collect();
        return Err(metadata_error(
            "VIDEO_PROBE_FAILED",
            format!("无法获取本地视频时长：{stderr}"),
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        metadata_error(
            "VIDEO_PROBE_FAILED",
            format!("无法解析本地视频信息：{error}"),
        )
    })?;
    let video = value
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|streams| streams.first())
        .ok_or_else(|| metadata_error("VIDEO_PROBE_FAILED", "文件中没有可用的视频流"))?;
    let duration = numeric_value(video.get("duration"))
        .or_else(|| numeric_value(value.pointer("/format/duration")))
        .filter(|duration| duration.is_finite() && *duration >= 0.05)
        .ok_or_else(|| metadata_error("VIDEO_PROBE_FAILED", "无法确定本地视频的真实总时长"))?;
    let mut width = video.get("width").and_then(Value::as_u64).unwrap_or(0);
    let mut height = video.get("height").and_then(Value::as_u64).unwrap_or(0);
    if width == 0 || height == 0 {
        return Err(metadata_error(
            "VIDEO_PROBE_FAILED",
            "无法获取本地视频的画面尺寸",
        ));
    }
    let rotation = numeric_value(video.pointer("/tags/rotate"))
        .or_else(|| {
            video
                .get("side_data_list")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find_map(|item| numeric_value(item.get("rotation")))
                })
        })
        .unwrap_or(0.0)
        .abs()
        % 180.0;
    if (rotation - 90.0).abs() < 1.0 {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(LocalVideoMetadata {
        duration,
        width,
        height,
        aspect_ratio: if width >= height { "16:9" } else { "9:16" }.to_owned(),
        size_bytes: file.len(),
    })
}

#[tauri::command]
pub async fn probe_local_video(video_path: String) -> Result<LocalVideoMetadata, String> {
    let path = PathBuf::from(video_path.trim());
    tauri::async_runtime::spawn_blocking(move || probe_video_metadata(&path))
        .await
        .map_err(|error| {
            metadata_error(
                "VIDEO_PROBE_TASK_ERROR",
                format!("视频信息读取任务异常：{error}"),
            )
        })?
}

pub fn compress_video_for_inline_analysis(
    source: &Path,
    destination: &Path,
    target_size: u64,
) -> Result<(), String> {
    let ffmpeg = resolve("ffmpeg", "AIVS_FFMPEG_PATH").map_err(|message| {
        json!({"code": "FFMPEG_NOT_AVAILABLE", "message": message, "retryable": false}).to_string()
    })?;
    let attempts = [("720", "30", "12"), ("540", "34", "10"), ("360", "38", "8")];
    let mut last_error = String::new();
    for (width, crf, fps) in attempts {
        let output = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(source)
            .args([
                "-vf",
                &format!("scale=w={width}:h=-2:force_original_aspect_ratio=decrease:force_divisible_by=2,fps={fps}"),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                crf,
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-ac",
                "1",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                "-sn",
            ])
            .arg(destination)
            .output()
            .map_err(|error| {
                json!({"code": "FFMPEG_NOT_AVAILABLE", "message": format!("视频超过中转平台内嵌上限，但无法启动 FFmpeg 进行压缩：{error}"), "retryable": false}).to_string()
            })?;
        if output.status.success() {
            if let Ok(metadata) = std::fs::metadata(destination) {
                if metadata.len() > 0 && metadata.len() <= target_size {
                    return Ok(());
                }
                last_error = format!(
                    "压缩后仍有 {:.1}MB",
                    metadata.len() as f64 / 1024.0 / 1024.0
                );
            }
        } else {
            last_error = String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(600)
                .collect();
        }
    }
    Err(json!({"code": "VIDEO_COMPRESSION_FAILED", "message": format!("无法将视频压缩到中转平台可接受的大小：{last_error}"), "retryable": true}).to_string())
}
