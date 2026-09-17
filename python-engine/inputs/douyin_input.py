import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


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


class _NoShareRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_douyin_url(
    share_text: str,
    opener: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    input_url = extract_douyin_url(share_text)
    platform = detect_video_platform(input_url)
    open_url = opener or (build_opener(_NoShareRedirect()).open if platform == "DOUYIN" else urlopen)
    current = input_url
    status = None
    for _ in range(8):
        if detect_video_platform(current) != platform:
            raise DouyinResolverError("DOUYIN_REDIRECT_NOT_ALLOWED", "视频分享链接跳转到了非官方地址，已停止解析")
        video_id = _video_id(current, platform)
        if platform == "DOUYIN" and video_id:
            return {"input_url": input_url, "canonical_url": "https://www.douyin.com/video/" + video_id,
                    "video_id": video_id, "status": status, "platform": platform}
        request = Request(current, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        })
        try:
            with open_url(request, timeout=15) as response:
                current = str(response.geturl() or current)
                status = int(getattr(response, "status", 200) or 200)
                if detect_video_platform(current) != platform:
                    raise DouyinResolverError("DOUYIN_REDIRECT_NOT_ALLOWED", "视频分享链接跳转到了非官方地址，已停止解析")
                if platform != "DOUYIN" or _video_id(current, platform):
                    break
                location = (getattr(response, "headers", {}) or {}).get("Location")
                if location and 300 <= status < 400:
                    current = urljoin(current, location)
                    continue
                html = response.read(1024 * 1024).decode("utf-8", errors="replace")
                next_url = _douyin_url_from_html(html, current)
                if next_url:
                    current = next_url
                    continue
                # A random aweme_id in homepage/recommendation HTML is not proof
                # of the short link's identity. Only explicit redirects are trusted.
                break
        except HTTPError as exc:
            status = int(exc.code)
            if status in (404, 410):
                raise DouyinResolverError("DOUYIN_VIDEO_UNAVAILABLE", "该视频已删除、设为私密或分享链接已失效，无法解析。")
            location = (exc.headers or {}).get("Location")
            if location and 300 <= status < 400:
                current = urljoin(current, location)
                continue
            break
        except (URLError, OSError, TimeoutError):
            break
    if detect_video_platform(current) != platform:
        raise DouyinResolverError("DOUYIN_REDIRECT_NOT_ALLOWED", "视频分享链接跳转到了非官方地址，已停止解析")
    video_id = _video_id(current, platform)
    if platform == "DOUYIN":
        if not video_id:
            raise DouyinResolverError("DOUYIN_VIDEO_ID_MISSING", "分享链接未能确认目标作品 ID，请检查链接或网络后重试", retryable=True)
        current = "https://www.douyin.com/video/" + video_id
    return {"input_url": input_url, "canonical_url": current, "video_id": video_id, "status": status, "platform": platform}


def _video_id(url: str, platform: Optional[str] = None) -> str:
    value = str(url or "")
    if platform == "BILIBILI":
        match = re.search(r"/(?:video/)?((?:BV)[0-9A-Za-z]+|av\d+)", value, re.IGNORECASE)
    elif platform == "KUAISHOU":
        match = re.search(r"/(?:short-video|photo|s)/([0-9A-Za-z_-]+)", value, re.IGNORECASE)
    else:
        match = re.search(r"/(?:share/)?(?:video|note|slides)/(\d+)", value)
        if match:
            return match.group(1)
        try:
            query = parse_qs(urlparse(value).query)
        except (TypeError, ValueError):
            return ""
        for key in ("modal_id", "aweme_id", "item_ids", "item_id"):
            candidate = str((query.get(key) or [""])[0])
            if re.fullmatch(r"\d{6,}", candidate):
                return candidate
        return ""
    return match.group(1) if match else ""


def _douyin_url_from_html(html: str, base_url: str) -> str:
    patterns = (
        r'''window\.location\.href\s*=\s*["']([^"']+)["']''',
        r'''window\.location\.replace\(\s*["']([^"']+)["']''',
        r'''<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=([^"']+)["']''',
    )
    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return urljoin(base_url, match.group(1).replace("&amp;", "&"))
    return ""


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
    normalized = _normalize_info(info, url, platform)
    expected_video_id = _video_id(url, platform)
    actual_video_id = str(normalized.get("id") or "")
    if expected_video_id and actual_video_id != expected_video_id:
        raise DouyinResolverError(
            "DOUYIN_VIDEO_ID_MISMATCH",
            "解析结果与分享链接不是同一个作品，已停止使用该视频",
            retryable=True,
        )
    return normalized


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
        if "did not get any data blocks" in detail.lower():
            raise DouyinResolverError(
                "DOUYIN_DOWNLOAD_NO_DATA",
                "视频平台的下载节点没有继续返回数据，需要刷新视频地址后重试。",
                retryable=True,
            )
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
    download_urls: List[str] = []
    for value in [video_info.get("download_url"), *(video_info.get("download_urls") or [])]:
        url = str(value or "").strip()
        if url.startswith(("http://", "https://")) and url not in download_urls:
            download_urls.append(url)
    if not download_urls:
        raise DouyinResolverError("DOUYIN_DIRECT_URL_MISSING", "浏览器页面没有返回可下载的视频地址", retryable=True)
    valid_download_urls = []
    for download_url in download_urls:
        try:
            media_path = urlparse(download_url).path.lower()
        except ValueError:
            continue
        if not media_path.endswith((".gif", ".jpg", ".jpeg", ".png", ".webp", ".svg", ".ico")):
            valid_download_urls.append(download_url)
    if not valid_download_urls:
        raise DouyinResolverError(
            "DOUYIN_DIRECT_URL_INVALID",
            "浏览器返回的是图片或统计资源，不是可下载的视频地址，正在重新解析。",
            retryable=True,
        )
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
    webpage_url = str(video_info.get("webpage_url") or "").strip()
    user_agent = str(video_info.get("user_agent") or "").strip()
    errors: List[str] = []
    for index, download_url in enumerate(valid_download_urls):
        candidate_info = dict(video_info)
        candidate_info["download_url"] = download_url
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
        if webpage_url:
            command.extend(["--referer", webpage_url])
        if user_agent:
            command.extend(["--user-agent", user_agent])
        command.append(download_url)
        try:
            completed = runner(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=1800,
                check=False,
            )
            yt_dlp_error = _last_error(completed.stderr) or "浏览器视频地址下载失败"
        except subprocess.TimeoutExpired:
            completed = None
            yt_dlp_error = "视频下载超时"
        except OSError as exc:
            completed = None
            yt_dlp_error = "无法启动视频下载：{0}".format(exc)
        if completed is not None and completed.returncode == 0 and os.path.isfile(destination) and os.path.getsize(destination) > 0:
            return {"saved_path": destination, "size_bytes": os.path.getsize(destination)}
        try:
            if os.path.isfile(destination):
                os.remove(destination)
        except OSError:
            pass
        try:
            return _download_direct_http(candidate_info, destination, cookie_path)
        except DouyinResolverError as http_error:
            errors.append("节点 {0}: {1}；HTTP: {2}".format(index + 1, yt_dlp_error, http_error))
    raise DouyinResolverError(
        "DOUYIN_DIRECT_DOWNLOAD_FAILED",
        "多个真实视频节点均下载失败：{0}".format(" | ".join(errors[-3:])),
        retryable=True,
    )


def _cookie_header(cookie_file_path: str, target_url: str) -> str:
    if not cookie_file_path:
        return ""
    parsed = urlparse(target_url)
    host = (parsed.hostname or "").lower()
    request_path = parsed.path or "/"
    secure = parsed.scheme.lower() == "https"
    cookies: List[str] = []
    try:
        with open(cookie_file_path, "r", encoding="utf-8", errors="replace") as cookie_file:
            for raw_line in cookie_file:
                line = raw_line.strip()
                if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
                    continue
                if line.startswith("#HttpOnly_"):
                    line = line[len("#HttpOnly_"):]
                fields = line.split("\t")
                if len(fields) < 7:
                    continue
                domain, _, cookie_path, secure_flag, _, name, value = fields[:7]
                normalized_domain = domain.lstrip(".").lower()
                if not host or not (host == normalized_domain or host.endswith("." + normalized_domain)):
                    continue
                if cookie_path and not request_path.startswith(cookie_path):
                    continue
                if secure_flag.upper() == "TRUE" and not secure:
                    continue
                if name:
                    cookies.append("{0}={1}".format(name, value))
    except OSError:
        return ""
    return "; ".join(cookies)


def _download_direct_http(
    video_info: Dict[str, Any],
    destination: str,
    cookie_file_path: str = "",
) -> Dict[str, Any]:
    download_url = str(video_info.get("download_url") or "").strip()
    try:
        expected_size = int(video_info.get("filesize") or 0)
    except (TypeError, ValueError):
        expected_size = 0
    webpage_url = str(video_info.get("webpage_url") or "").strip()
    user_agent = str(video_info.get("user_agent") or "").strip() or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    partial_path = destination + ".part"
    try:
        if os.path.exists(partial_path):
            os.remove(partial_path)
    except OSError:
        pass
    last_error = "服务器没有返回视频数据"
    for attempt in range(4):
        offset = os.path.getsize(partial_path) if os.path.isfile(partial_path) else 0
        headers = {
            "User-Agent": user_agent,
            "Accept": "*/*",
            "Accept-Encoding": "identity",
            "Connection": "close",
        }
        if webpage_url:
            headers["Referer"] = webpage_url
        cookie_header = _cookie_header(cookie_file_path, download_url)
        if cookie_header:
            headers["Cookie"] = cookie_header
        if offset:
            headers["Range"] = "bytes={0}-".format(offset)
        try:
            request = Request(download_url, headers=headers, method="GET")
            with urlopen(request, timeout=60) as response:
                status = int(getattr(response, "status", response.getcode()) or 200)
                if offset and status != 206:
                    offset = 0
                mode = "ab" if offset and status == 206 else "wb"
                received = 0
                with open(partial_path, mode) as output_file:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        output_file.write(block)
                        received += len(block)
                if received <= 0:
                    last_error = "服务器返回了空视频数据"
                    continue
                total = None
                content_range = str(response.headers.get("Content-Range") or "")
                range_match = re.search(r"/(\d+)$", content_range)
                if range_match:
                    total = int(range_match.group(1))
                elif response.headers.get("Content-Length"):
                    try:
                        length = int(response.headers["Content-Length"])
                    except (TypeError, ValueError):
                        length = 0
                    if length > 0:
                        total = offset + length if status == 206 else length
                current_size = os.path.getsize(partial_path)
                if expected_size > 0 and current_size < expected_size:
                    last_error = "视频连接提前中断（已下载 {0}/{1} 字节）".format(current_size, expected_size)
                    continue
                if total is not None and current_size < total:
                    last_error = "视频连接提前中断（已下载 {0}/{1} 字节）".format(current_size, total)
                    continue
                os.replace(partial_path, destination)
                return {"saved_path": destination, "size_bytes": os.path.getsize(destination)}
        except HTTPError as exc:
            last_error = "HTTP {0}".format(exc.code)
            if exc.code in (401, 403, 404):
                break
        except (URLError, OSError, ValueError) as exc:
            last_error = str(exc)
        if attempt < 3:
            continue
    try:
        if os.path.exists(partial_path):
            os.remove(partial_path)
    except OSError:
        pass
    raise DouyinResolverError("DOUYIN_DIRECT_HTTP_DOWNLOAD_FAILED", last_error, retryable=True)


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
    download_urls = []
    for item in [selected, *candidates, info]:
        candidate_url = str(item.get("url") or "")
        if candidate_url.startswith(("http://", "https://")) and candidate_url not in download_urls:
            download_urls.append(candidate_url)
    return {
        "id": str(info.get("id") or ""),
        "title": str(info.get("title") or info.get("description") or "短视频"),
        "uploader": str(info.get("uploader") or info.get("creator") or ""),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "webpage_url": str(info.get("webpage_url") or input_url),
        "download_url": str(download_url),
        "download_urls": download_urls,
        "filesize": selected.get("filesize") or selected.get("filesize_approx") or info.get("filesize") or info.get("filesize_approx"),
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
