import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
PLATFORM_HOSTS = {
    "DOUYIN": ("douyin.com", "iesdouyin.com"),
    "KUAISHOU": ("kuaishou.com", "gifshow.com", "kwai.com"),
    "BILIBILI": ("bilibili.com", "b23.tv"),
}
PLATFORM_NAMES = {
    "DOUYIN": "抖音",
    "KUAISHOU": "快手",
    "BILIBILI": "哔哩哔哩",
}
ALLOWED_COOKIE_BROWSERS = ("edge", "chrome", "firefox")


class DouyinResolverError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def extract_douyin_url(share_text: str) -> str:
    value = str(share_text or "").strip()
    match = URL_PATTERN.search(value)
    if not match:
        raise DouyinResolverError("DOUYIN_URL_NOT_FOUND", "分享内容中没有找到 http/https 链接")
    url = match.group(0).rstrip("。！？；，,.!?;:)]}")
    if not detect_video_platform(url):
        raise DouyinResolverError(
            "DOUYIN_DOMAIN_NOT_ALLOWED",
            "仅支持抖音、快手和哔哩哔哩的官方视频分享链接",
        )
    return url


def detect_video_platform(url: str) -> Optional[str]:
    host = (urlparse(str(url or "")).hostname or "").lower().rstrip(".")
    for platform, allowed_hosts in PLATFORM_HOSTS.items():
        if any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts):
            return platform
    return None


def probe_douyin_url(
    share_text: str,
    opener: Callable[..., Any] = urlopen,
) -> Dict[str, Any]:
    input_url = extract_douyin_url(share_text)
    input_platform = detect_video_platform(input_url)
    request = Request(input_url, method="GET", headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
    })
    try:
        with opener(request, timeout=15) as response:
            canonical_url = str(response.geturl() or input_url)
            status = int(getattr(response, "status", 200) or 200)
    except HTTPError as exc:
        try:
            canonical_url = str(exc.geturl() or input_url)
        except Exception:
            canonical_url = input_url
        status = int(exc.code)
        if status not in (404, 410):
            return {"input_url": input_url, "canonical_url": input_url, "video_id": _video_id(input_url, input_platform), "status": None, "platform": input_platform}
    except (URLError, OSError, TimeoutError):
        # A transient preflight failure must not block the existing resolver and
        # browser fallback, which can still succeed through a different route.
        return {"input_url": input_url, "canonical_url": input_url, "video_id": _video_id(input_url, input_platform), "status": None, "platform": input_platform}
    canonical_platform = detect_video_platform(canonical_url)
    if not canonical_platform or canonical_platform != input_platform:
        raise DouyinResolverError("DOUYIN_REDIRECT_NOT_ALLOWED", "视频分享链接跳转到了非官方地址，已停止解析")
    video_id = _video_id(canonical_url, canonical_platform)
    if status in (404, 410):
        raise DouyinResolverError(
            "DOUYIN_VIDEO_UNAVAILABLE",
            "该视频已删除、设为私密或分享链接已失效，无法解析。请更换一个仍可正常播放的视频链接。",
        )
    return {"input_url": input_url, "canonical_url": canonical_url, "video_id": video_id, "status": status, "platform": canonical_platform}


def _video_id(url: str, platform: Optional[str] = None) -> str:
    value = str(url or "")
    if platform == "BILIBILI":
        match = re.search(r"/(?:video/)?((?:BV)[0-9A-Za-z]+|av\d+)", value, re.IGNORECASE)
    elif platform == "KUAISHOU":
        match = re.search(r"/(?:short-video|photo|s)/([0-9A-Za-z_-]+)", value, re.IGNORECASE)
    else:
        match = re.search(r"/(?:share/)?video/(\d+)", value)
    return match.group(1) if match else ""


def resolve_douyin(
    share_text: str,
    browser_cookie_source: Optional[str] = None,
    browser_profile_path: Optional[str] = None,
    cookie_file_path: Optional[str] = None,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    executable: Optional[str] = None,
) -> Dict[str, Any]:
    url = extract_douyin_url(share_text)
    platform = detect_video_platform(url)
    browser = str(browser_cookie_source or "").strip().lower()
    profile_path = str(browser_profile_path or "").strip()
    cookie_path = str(cookie_file_path or "").strip()
    if browser and browser not in ALLOWED_COOKIE_BROWSERS:
        raise DouyinResolverError("DOUYIN_COOKIE_BROWSER_NOT_ALLOWED", "仅支持从 Edge、Chrome 或 Firefox 读取 Cookie")
    if profile_path and browser not in ("chrome", "edge"):
        raise DouyinResolverError("DOUYIN_BROWSER_PROFILE_INVALID", "专用浏览器资料目录仅支持 Chrome 或 Edge")
    if profile_path and not os.path.isdir(profile_path):
        raise DouyinResolverError("DOUYIN_BROWSER_PROFILE_NOT_FOUND", "专用浏览器登录资料不存在")
    if browser and cookie_path:
        raise DouyinResolverError("DOUYIN_COOKIE_SOURCE_CONFLICT", "浏览器 Cookie 和 Cookie 文件不能同时使用")
    if cookie_path:
        _validate_cookie_file(cookie_path)
    yt_dlp = executable or find_yt_dlp()
    if not yt_dlp:
        raise DouyinResolverError(
            "DOUYIN_RESOLVER_NOT_INSTALLED",
            "未找到 yt-dlp。请将官方独立程序放到 binaries/yt-dlp/yt-dlp.exe",
        )
    command = [
        yt_dlp,
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout", "15",
        "--retries", "1",
    ]
    if browser:
        browser_spec = browser if not profile_path else "{0}:{1}".format(browser, profile_path)
        command.extend(["--cookies-from-browser", browser_spec])
    cookie_temp_dir = None
    if cookie_path:
        try:
            cookie_temp_dir = tempfile.TemporaryDirectory(prefix="aivs_douyin_cookies_")
            temporary_cookie_path = os.path.join(cookie_temp_dir.name, "cookies.txt")
            shutil.copyfile(cookie_path, temporary_cookie_path)
            command.extend(["--cookies", temporary_cookie_path])
        except OSError as exc:
            if cookie_temp_dir:
                cookie_temp_dir.cleanup()
            raise DouyinResolverError("DOUYIN_COOKIE_FILE_COPY_FAILED", "无法创建 Cookie 临时副本：{0}".format(exc))
    command.append(url)
    try:
        completed = runner(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45, check=False)
    except subprocess.TimeoutExpired:
        raise DouyinResolverError("DOUYIN_RESOLVE_TIMEOUT", "解析超时，请检查网络后重试", retryable=True)
    except OSError as exc:
        raise DouyinResolverError("DOUYIN_RESOLVER_START_FAILED", "无法启动 yt-dlp：{0}".format(exc), retryable=True)
    finally:
        if cookie_temp_dir:
            cookie_temp_dir.cleanup()
    if completed.returncode != 0:
        detail = _last_error(completed.stderr)
        if "fresh cookies" in detail.lower():
            if browser:
                raise DouyinResolverError(
                    "DOUYIN_BROWSER_COOKIES_STALE",
                    "未从 {0} 读取到可用的平台 Cookie。请先用该浏览器打开视频页面并刷新，然后重试。".format(browser.title()),
                    retryable=True,
                )
            if cookie_path:
                raise DouyinResolverError(
                    "DOUYIN_COOKIE_FILE_STALE",
                    "Cookie 文件中没有可用的新鲜平台 Cookie。请重新导出后再选择该文件。",
                    retryable=True,
                )
            raise DouyinResolverError(
                "DOUYIN_FRESH_COOKIES_REQUIRED",
                "视频平台要求新鲜 Cookie。请先用浏览器打开该视频，再选择对应的 Cookie 来源重试。",
                retryable=True,
            )
        if browser and "could not copy" in detail.lower() and "cookie database" in detail.lower():
            raise DouyinResolverError(
                "DOUYIN_BROWSER_COOKIE_DATABASE_LOCKED",
                "{0} 正在占用 Cookie 数据库。请完全退出浏览器（包括后台进程）后重试，或改用 Cookie 文件。".format(browser.title()),
                retryable=True,
            )
        if browser and any(marker in detail.lower() for marker in ("cookie", "decrypt", "keyring")):
            raise DouyinResolverError(
                "DOUYIN_BROWSER_COOKIES_FAILED",
                "无法读取 {0} Cookie：{1}".format(browser.title(), detail),
                retryable=True,
            )
        if cookie_path and "cookie" in detail.lower():
            raise DouyinResolverError("DOUYIN_COOKIE_FILE_FAILED", "Cookie 文件无法使用：{0}".format(detail), retryable=True)
        raise DouyinResolverError("DOUYIN_EXTRACT_FAILED", detail or "视频页面解析失败，链接可能已失效或需要登录", retryable=True)
    try:
        info = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise DouyinResolverError("DOUYIN_INVALID_RESPONSE", "解析器返回了无效 JSON：{0}".format(exc), retryable=True)
    return _normalize_info(info, url, platform)


def download_douyin(
    share_text: str,
    output_path: str,
    browser_cookie_source: Optional[str] = None,
    browser_profile_path: Optional[str] = None,
    cookie_file_path: Optional[str] = None,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    executable: Optional[str] = None,
) -> Dict[str, Any]:
    url = extract_douyin_url(share_text)
    requested_destination = str(output_path or "").strip()
    if not requested_destination:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_PATH_REQUIRED", "请选择视频保存位置")
    destination = os.path.abspath(requested_destination)
    parent = os.path.dirname(destination)
    if not parent or not os.path.isdir(parent):
        raise DouyinResolverError("DOUYIN_DOWNLOAD_DIRECTORY_NOT_FOUND", "所选保存目录不存在")
    browser = str(browser_cookie_source or "").strip().lower()
    profile_path = str(browser_profile_path or "").strip()
    cookie_path = str(cookie_file_path or "").strip()
    if browser and browser not in ALLOWED_COOKIE_BROWSERS:
        raise DouyinResolverError("DOUYIN_COOKIE_BROWSER_NOT_ALLOWED", "仅支持从 Edge、Chrome 或 Firefox 读取 Cookie")
    if profile_path and browser not in ("chrome", "edge"):
        raise DouyinResolverError("DOUYIN_BROWSER_PROFILE_INVALID", "专用浏览器资料目录仅支持 Chrome 或 Edge")
    if profile_path and not os.path.isdir(profile_path):
        raise DouyinResolverError("DOUYIN_BROWSER_PROFILE_NOT_FOUND", "专用浏览器登录资料不存在")
    if browser and cookie_path:
        raise DouyinResolverError("DOUYIN_COOKIE_SOURCE_CONFLICT", "浏览器 Cookie 和 Cookie 文件不能同时使用")
    if cookie_path:
        _validate_cookie_file(cookie_path)
    yt_dlp = executable or find_yt_dlp()
    if not yt_dlp:
        raise DouyinResolverError("DOUYIN_RESOLVER_NOT_INSTALLED", "未找到 yt-dlp，无法下载视频")
    command = [
        yt_dlp,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--force-overwrites",
        "--socket-timeout", "20",
        "--retries", "2",
        "--format", "best[ext=mp4]/best",
        "--output", destination,
    ]
    if browser:
        browser_spec = browser if not profile_path else "{0}:{1}".format(browser, profile_path)
        command.extend(["--cookies-from-browser", browser_spec])
    cookie_temp_dir = None
    if cookie_path:
        try:
            cookie_temp_dir = tempfile.TemporaryDirectory(prefix="aivs_douyin_download_cookies_")
            temporary_cookie_path = os.path.join(cookie_temp_dir.name, "cookies.txt")
            shutil.copyfile(cookie_path, temporary_cookie_path)
            command.extend(["--cookies", temporary_cookie_path])
        except OSError as exc:
            if cookie_temp_dir:
                cookie_temp_dir.cleanup()
            raise DouyinResolverError("DOUYIN_COOKIE_FILE_COPY_FAILED", "无法创建 Cookie 临时副本：{0}".format(exc))
    command.append(url)
    try:
        completed = runner(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
    except subprocess.TimeoutExpired:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_TIMEOUT", "视频下载超时，请检查网络后重试", retryable=True)
    except OSError as exc:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_START_FAILED", "无法启动视频下载：{0}".format(exc), retryable=True)
    finally:
        if cookie_temp_dir:
            cookie_temp_dir.cleanup()
    if completed.returncode != 0:
        detail = _last_error(completed.stderr)
        if "fresh cookies" in detail.lower():
            if cookie_path:
                raise DouyinResolverError("DOUYIN_COOKIE_FILE_STALE", "Cookie 已失效，请重新登录后下载", retryable=True)
            raise DouyinResolverError("DOUYIN_BROWSER_COOKIES_STALE", "Cookie 已失效，请重新登录后下载", retryable=True)
        raise DouyinResolverError("DOUYIN_DOWNLOAD_FAILED", detail or "视频下载失败", retryable=True)
    if not os.path.isfile(destination):
        raise DouyinResolverError("DOUYIN_DOWNLOAD_FILE_MISSING", "下载已结束，但没有找到保存的视频文件", retryable=True)
    return {"saved_path": destination, "size_bytes": os.path.getsize(destination)}


def download_direct_video(
    video_info: Dict[str, Any],
    output_path: str,
    cookie_file_path: Optional[str] = None,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    executable: Optional[str] = None,
) -> Dict[str, Any]:
    download_url = str(video_info.get("download_url") or "").strip()
    if not download_url.startswith(("http://", "https://")):
        raise DouyinResolverError("DOUYIN_DIRECT_URL_MISSING", "浏览器页面没有返回可下载的视频地址", retryable=True)
    requested_destination = str(output_path or "").strip()
    if not requested_destination:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_PATH_REQUIRED", "请选择视频保存位置")
    destination = os.path.abspath(requested_destination)
    parent = os.path.dirname(destination)
    if not parent or not os.path.isdir(parent):
        raise DouyinResolverError("DOUYIN_DOWNLOAD_DIRECTORY_NOT_FOUND", "所选保存目录不存在")
    cookie_path = str(cookie_file_path or "").strip()
    if cookie_path:
        _validate_cookie_file(cookie_path)
    yt_dlp = executable or find_yt_dlp()
    if not yt_dlp:
        raise DouyinResolverError("DOUYIN_RESOLVER_NOT_INSTALLED", "未找到 yt-dlp，无法下载视频")
    command = [
        yt_dlp,
        "--no-warnings",
        "--no-progress",
        "--force-overwrites",
        "--socket-timeout", "20",
        "--retries", "2",
        "--output", destination,
    ]
    if cookie_path:
        command.extend(["--cookies", cookie_path])
    webpage_url = str(video_info.get("webpage_url") or "").strip()
    if webpage_url:
        command.extend(["--referer", webpage_url])
    user_agent = str(video_info.get("user_agent") or "").strip()
    if user_agent:
        command.extend(["--user-agent", user_agent])
    command.append(download_url)
    try:
        completed = runner(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
    except subprocess.TimeoutExpired:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_TIMEOUT", "视频下载超时，请检查网络后重试", retryable=True)
    except OSError as exc:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_START_FAILED", "无法启动视频下载：{0}".format(exc), retryable=True)
    if completed.returncode != 0:
        raise DouyinResolverError("DOUYIN_DIRECT_DOWNLOAD_FAILED", _last_error(completed.stderr) or "浏览器视频地址下载失败", retryable=True)
    if not os.path.isfile(destination):
        raise DouyinResolverError("DOUYIN_DOWNLOAD_FILE_MISSING", "下载已结束，但没有找到保存的视频文件", retryable=True)
    return {"saved_path": destination, "size_bytes": os.path.getsize(destination)}


def find_yt_dlp() -> Optional[str]:
    configured = os.environ.get("AIVS_YTDLP_PATH")
    candidates: List[str] = []
    if configured:
        candidates.append(configured)
    discovered = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if discovered:
        candidates.append(discovered)
    engine_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repository_root = os.path.dirname(engine_root)
    candidates.extend([
        os.path.join(repository_root, "binaries", "yt-dlp", "yt-dlp.exe"),
        os.path.join(repository_root, "binaries", "yt-dlp", "yt-dlp"),
    ])
    return next((path for path in candidates if os.path.isfile(path)), None)


def _validate_cookie_file(path: str) -> None:
    if not os.path.isfile(path):
        raise DouyinResolverError("DOUYIN_COOKIE_FILE_NOT_FOUND", "所选 Cookie 文件不存在")
    try:
        with open(path, "rb") as cookie_file:
            first_line = cookie_file.readline(256).decode("utf-8-sig", errors="replace").strip()
    except OSError as exc:
        raise DouyinResolverError("DOUYIN_COOKIE_FILE_READ_FAILED", "无法读取 Cookie 文件：{0}".format(exc))
    if first_line not in ("# HTTP Cookie File", "# Netscape HTTP Cookie File"):
        raise DouyinResolverError(
            "DOUYIN_COOKIE_FILE_INVALID",
            "Cookie 文件必须是 Netscape 格式，首行应为 # Netscape HTTP Cookie File",
        )


def _normalize_info(info: Dict[str, Any], input_url: str, platform: Optional[str] = None) -> Dict[str, Any]:
    formats = [item for item in (info.get("formats") or []) if item.get("url")]
    combined = [item for item in formats if item.get("vcodec") not in (None, "none") and item.get("acodec") not in (None, "none")]
    candidates = combined or [item for item in formats if item.get("vcodec") not in (None, "none")]
    candidates.sort(key=lambda item: (
        int(item.get("height") or 0),
        float(item.get("tbr") or 0),
        int(item.get("filesize") or item.get("filesize_approx") or 0),
    ), reverse=True)
    selected = candidates[0] if candidates else info
    download_url = selected.get("url") or info.get("url")
    if not download_url:
        raise DouyinResolverError("DOUYIN_DOWNLOAD_URL_MISSING", "已识别视频，但未返回可用媒体地址", retryable=True)
    return {
        "id": str(info.get("id") or ""),
        "title": str(info.get("title") or info.get("description") or "短视频"),
        "uploader": str(info.get("uploader") or info.get("creator") or ""),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "webpage_url": str(info.get("webpage_url") or input_url),
        "download_url": str(download_url),
        "ext": str(selected.get("ext") or info.get("ext") or "mp4"),
        "width": selected.get("width") or info.get("width"),
        "height": selected.get("height") or info.get("height"),
        "format_id": selected.get("format_id") or info.get("format_id"),
        "extractor": str(info.get("extractor_key") or info.get("extractor") or platform or "Video"),
        "platform": platform or detect_video_platform(str(info.get("webpage_url") or input_url)) or "UNKNOWN",
        "platform_name": PLATFORM_NAMES.get(platform or "", "未知平台"),
    }


def _last_error(stderr: str) -> str:
    lines = [line.strip() for line in str(stderr or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if "ERROR:" in line:
            return line.split("ERROR:", 1)[1].strip()
    return lines[-1] if lines else ""
