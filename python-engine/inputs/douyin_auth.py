import json
import base64
import os
import re
import socket
import subprocess
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen


AUTH_COOKIE_NAMES = {"sessionid", "sessionid_ss"}
FRESH_COOKIE_NAMES = {"s_v_web_id", "ttwid"}
DOUYIN_HOST_SUFFIXES = ("douyin.com", "iesdouyin.com")
PLATFORM_BROWSER_HOSTS = {
    "KUAISHOU": ("kuaishou.com", "gifshow.com", "kwai.com"),
    "BILIBILI": ("bilibili.com", "b23.tv"),
}
MANAGED_COOKIE_FILE_NAME = "douyin-cookies.txt"


class DouyinAuthError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def has_managed_profile(profile_root: str) -> bool:
    return os.path.isfile(managed_cookie_file(profile_root)) or any(os.path.isfile(path) for path in (
        os.path.join(profile_root, "Default", "Network", "Cookies"),
        os.path.join(profile_root, "Default", "Cookies"),
    ))


def managed_cookie_file(profile_root: str) -> str:
    return os.path.join(profile_root, MANAGED_COOKIE_FILE_NAME)


def login_douyin(
    profile_root: str,
    browser_name: str,
    browser_executable: str,
    target_url: str = "https://v.douyin.com",
    timeout_seconds: int = 300,
) -> Dict[str, Any]:
    try:
        from websocket import WebSocketTimeoutException, create_connection
    except ImportError:
        raise DouyinAuthError("DOUYIN_CDP_DEPENDENCY_MISSING", "缺少 websocket-client，无法监测登录状态")

    os.makedirs(profile_root, exist_ok=True)
    port = _free_port()
    login_started_at = time.time()
    process = subprocess.Popen([
        browser_executable,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port={0}".format(port),
        "--remote-allow-origins=*",
        "--user-data-dir={0}".format(profile_root),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--new-window",
        target_url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    connection = None
    try:
        websocket_url = _wait_for_debugger(port, process, 20)
        connection = create_connection(websocket_url, timeout=3, origin="http://127.0.0.1:{0}".format(port))
        deadline = time.time() + timeout_seconds
        command_id = 0
        ready_since = None
        authenticated_seen = False
        authenticated_at = None
        next_video_probe_at = 0.0
        while time.time() < deadline:
            if process.poll() is not None:
                if authenticated_seen:
                    raise DouyinAuthError(
                        "DOUYIN_VIDEO_PAGE_NOT_READY",
                        "已检测到平台登录，但目标视频页尚未正常播放。请重新解析并在浏览器中完成验证或刷新视频页。",
                        retryable=True,
                    )
                raise DouyinAuthError("DOUYIN_LOGIN_CANCELLED", "登录窗口已关闭，尚未检测到平台登录状态", retryable=True)
            expected_video_id = _video_id_from_url(target_url)
            page_target = _find_douyin_page_target(port)
            page_video_id = _video_id_from_url(str((page_target or {}).get("url") or ""))
            if expected_video_id and page_video_id and page_video_id != expected_video_id:
                raise DouyinAuthError(
                    "DOUYIN_VIDEO_UNAVAILABLE",
                    "该视频已删除、设为私密或分享链接已失效，无法解析。请更换一个仍可正常播放的视频链接。",
                )
            command_id += 1
            cookies = _cdp(connection, command_id, "Storage.getCookies").get("cookies") or []
            douyin_cookies = [cookie for cookie in cookies if _is_douyin_cookie(cookie)]
            cookie_names = {str(cookie.get("name") or "") for cookie in douyin_cookies}
            has_login_cookie = bool(AUTH_COOKIE_NAMES.intersection(cookie_names))
            has_fresh_cookie = bool(FRESH_COOKIE_NAMES.intersection(cookie_names))
            if has_login_cookie and has_fresh_cookie:
                authenticated_seen = True
                if authenticated_at is None:
                    authenticated_at = time.time()
                if time.time() - authenticated_at > 30:
                    raise DouyinAuthError(
                        "DOUYIN_VIDEO_UNAVAILABLE",
                        "未能在浏览器中找到该目标作品。作品可能已被删除、设为私密、地区受限，或页面未通过安全验证。请先确认该链接在浏览器中可以正常播放。",
                    )
                if ready_since is None:
                    ready_since = time.time()
                # A managed profile can already contain sessionid from an earlier login.
                # Give the target video page enough time to refresh its anti-bot cookies;
                # otherwise the window closes immediately and yt-dlp sees stale cookies.
                if time.time() - ready_since < 4 or time.time() - login_started_at < 5:
                    time.sleep(0.5)
                    continue
                if time.time() < next_video_probe_at:
                    time.sleep(1)
                    continue
                cookie_file_path = managed_cookie_file(profile_root)
                _write_netscape_cookie_file(cookie_file_path, douyin_cookies)
                video_info = _read_video_page(
                    port,
                    process,
                    create_connection,
                    expected_video_id=expected_video_id,
                    timeout_seconds=12,
                )
                if not video_info:
                    # Do not close merely because an old session cookie exists. Keep
                    # the window available for login/captcha and only continue once
                    # the exact target video is visible to the browser.
                    next_video_probe_at = time.time() + 15
                    continue
                command_id += 1
                _cdp(connection, command_id, "Browser.close")
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
                _wait_for_cookie_file(cookie_file_path)
                return {
                    "authenticated": True,
                    "browser": browser_name,
                    "browser_profile_path": os.path.join(profile_root, "Default"),
                    "cookie_file_path": cookie_file_path,
                    "video": video_info,
                    "message": "平台登录成功，专用 {0} 已关闭".format(browser_name.title()),
                }
            ready_since = None
            time.sleep(1)
        if authenticated_seen:
            raise DouyinAuthError(
                "DOUYIN_VIDEO_UNAVAILABLE",
                "未能在浏览器中找到该目标作品。作品可能已被删除、设为私密、地区受限，或页面未通过安全验证。请先确认该链接在浏览器中可以正常播放。",
            )
        raise DouyinAuthError("DOUYIN_LOGIN_TIMEOUT", "等待平台登录超时，请重新发起登录", retryable=True)
    except WebSocketTimeoutException:
        raise DouyinAuthError("DOUYIN_LOGIN_MONITOR_TIMEOUT", "读取平台登录状态超时", retryable=True)
    finally:
        if connection:
            connection.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def find_chrome() -> Optional[str]:
    return _find_chromium_browser("chrome")


def find_edge() -> Optional[str]:
    return _find_chromium_browser("edge")


def find_managed_browser() -> Tuple[str, str]:
    for browser_name, finder in (("chrome", find_chrome), ("edge", find_edge)):
        executable = finder()
        if executable:
            return browser_name, executable
    raise DouyinAuthError(
        "DOUYIN_MANAGED_BROWSER_NOT_FOUND",
        "未找到 Chrome 或 Microsoft Edge。请安装其中一个浏览器，或改用 Netscape Cookie 文件。",
    )


def browser_availability() -> Dict[str, Any]:
    chrome = bool(find_chrome())
    edge = bool(find_edge())
    return {
        "chrome": chrome,
        "edge": edge,
        "can_auto_login": chrome or edge,
        "preferred": "chrome" if chrome else "edge" if edge else None,
    }


def resolve_video_in_browser(
    profile_root: str,
    browser_name: str,
    browser_executable: str,
    target_url: str,
    platform: str,
    timeout_seconds: int = 120,
) -> Dict[str, Any]:
    try:
        from websocket import create_connection
    except ImportError:
        raise DouyinAuthError("VIDEO_CDP_DEPENDENCY_MISSING", "缺少 websocket-client，无法通过浏览器读取视频", retryable=True)
    host_suffixes = PLATFORM_BROWSER_HOSTS.get(platform)
    if not host_suffixes:
        raise DouyinAuthError("VIDEO_PLATFORM_BROWSER_UNSUPPORTED", "该平台不支持浏览器解析", retryable=False)
    os.makedirs(profile_root, exist_ok=True)
    port = _free_port()
    process = subprocess.Popen([
        browser_executable,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port={0}".format(port),
        "--remote-allow-origins=*",
        "--user-data-dir={0}".format(profile_root),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--new-window",
        target_url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    browser_connection = None
    page_connection = None
    try:
        browser_websocket_url = _wait_for_debugger(port, process, 20)
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if process.poll() is not None:
                raise DouyinAuthError("VIDEO_BROWSER_CANCELLED", "专用浏览器窗口已关闭，尚未读取到可播放视频", retryable=True)
            target = _find_page_target(port, host_suffixes)
            if not target:
                time.sleep(0.5)
                continue
            if page_connection:
                page_connection.close()
            page_connection = create_connection(
                str(target["webSocketDebuggerUrl"]),
                timeout=3,
                origin="http://127.0.0.1:{0}".format(port),
            )
            video_id = _platform_video_id(str(target.get("url") or target_url), platform)
            video = _capture_video_from_network(
                page_connection,
                video_id,
                timeout_seconds=min(18, max(3, deadline - time.time())),
                webpage_url=str(target.get("url") or target_url),
                platform=platform,
            )
            if video:
                browser_connection = create_connection(
                    browser_websocket_url,
                    timeout=3,
                    origin="http://127.0.0.1:{0}".format(port),
                )
                cookies = _cdp(browser_connection, 900, "Storage.getCookies").get("cookies") or []
                cookie_path = os.path.join(profile_root, "{0}-cookies.txt".format(platform.lower()))
                if _write_platform_cookie_file(cookie_path, cookies, host_suffixes):
                    video["cookie_file_path"] = cookie_path
                return video
            time.sleep(1)
        raise DouyinAuthError(
            "VIDEO_BROWSER_RESOLVE_TIMEOUT",
            "等待浏览器加载视频超时，请在专用窗口中完成登录或验证后重试",
            retryable=True,
        )
    finally:
        if page_connection:
            page_connection.close()
        if browser_connection:
            browser_connection.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def _find_chromium_browser(browser_name: str) -> Optional[str]:
    configured = os.environ.get("AIVS_{0}_PATH".format(browser_name.upper()))
    candidates: List[str] = [configured] if configured else []
    if os.name == "nt":
        executable_name = "chrome.exe" if browser_name == "chrome" else "msedge.exe"
        app_paths_key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{0}".format(executable_name)
        app_paths_wow_key = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{0}".format(executable_name)
        try:
            import winreg
            for hive, key_path in (
                (winreg.HKEY_CURRENT_USER, app_paths_key),
                (winreg.HKEY_LOCAL_MACHINE, app_paths_key),
                (winreg.HKEY_LOCAL_MACHINE, app_paths_wow_key),
            ):
                try:
                    with winreg.OpenKey(hive, key_path) as key:
                        candidates.append(winreg.QueryValue(key, None))
                except OSError:
                    pass
        except ImportError:
            pass
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("PROGRAMFILES", "")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)", "")
        if browser_name == "chrome":
            candidates.extend([
                os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(local_app_data, "Google", "Chrome", "Bin", "chrome.exe"),
                os.path.join(program_files, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(program_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
            ])
        else:
            candidates.extend([
                os.path.join(local_app_data, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(program_files, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(program_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
            ])
    return next((path for path in candidates if path and os.path.isfile(path)), None)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_debugger(port: int, process: subprocess.Popen, timeout_seconds: int) -> str:
    deadline = time.time() + timeout_seconds
    endpoint = "http://127.0.0.1:{0}/json/version".format(port)
    while time.time() < deadline:
        if process.poll() is not None:
            raise DouyinAuthError("DOUYIN_CHROME_START_FAILED", "Chrome 登录窗口启动失败", retryable=True)
        try:
            with urlopen(endpoint, timeout=1) as response:
                payload = json.loads(response.read().decode("utf-8"))
            websocket_url = payload.get("webSocketDebuggerUrl")
            if websocket_url:
                return str(websocket_url)
        except Exception:
            time.sleep(0.2)
    raise DouyinAuthError("DOUYIN_CHROME_DEBUG_TIMEOUT", "无法连接专用 Chrome 登录窗口", retryable=True)


def _cdp(connection: Any, command_id: int, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"id": command_id, "method": method}
    if params:
        payload["params"] = params
    connection.send(json.dumps(payload))
    while True:
        payload = json.loads(connection.recv())
        if payload.get("id") != command_id:
            continue
        if payload.get("error"):
            raise DouyinAuthError("DOUYIN_CDP_ERROR", str(payload["error"]), retryable=True)
        return payload.get("result") or {}


def _is_douyin_cookie(cookie: Dict[str, Any]) -> bool:
    domain = str(cookie.get("domain") or "").lower().lstrip(".")
    return any(domain == suffix or domain.endswith("." + suffix) for suffix in DOUYIN_HOST_SUFFIXES)


def _write_netscape_cookie_file(path: str, cookies: List[Dict[str, Any]]) -> None:
    if not _write_platform_cookie_file(path, cookies, DOUYIN_HOST_SUFFIXES):
        raise DouyinAuthError("DOUYIN_COOKIE_EXPORT_EMPTY", "没有读取到可保存的平台 Cookie", retryable=True)


def _write_platform_cookie_file(path: str, cookies: List[Dict[str, Any]], host_suffixes: Tuple[str, ...]) -> bool:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    lines = ["# Netscape HTTP Cookie File", "# Generated by AI Video Studio; contains sensitive login data."]
    for cookie in cookies:
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        domain = str(cookie.get("domain") or "")
        normalized_domain = domain.lower().lstrip(".")
        if not name or not domain or not any(
            normalized_domain == suffix or normalized_domain.endswith("." + suffix) for suffix in host_suffixes
        ):
            continue
        include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
        cookie_path = str(cookie.get("path") or "/")
        secure = "TRUE" if cookie.get("secure") else "FALSE"
        try:
            expires = max(0, int(float(cookie.get("expires") or 0)))
        except (TypeError, ValueError, OverflowError):
            expires = 0
        lines.append("\t".join((domain, include_subdomains, cookie_path, secure, str(expires), name, value)))
    if len(lines) == 2:
        return False
    fd, temporary_path = tempfile.mkstemp(prefix=".douyin-cookies-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as cookie_file:
            cookie_file.write("\n".join(lines) + "\n")
        try:
            os.chmod(temporary_path, 0o600)
        except OSError:
            pass
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)
    return True


def _wait_for_cookie_file(path: str, timeout_seconds: float = 5) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise DouyinAuthError("DOUYIN_COOKIE_EXPORT_FAILED", "平台 Cookie 未能保存到本地，请重试", retryable=True)


def _read_video_page(
    port: int,
    process: subprocess.Popen,
    connection_factory: Callable[..., Any],
    expected_video_id: str = "",
    timeout_seconds: float = 12,
) -> Optional[Dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    page_connection = None
    try:
        while time.time() < deadline:
            if process.poll() is not None:
                return None
            target = _find_douyin_page_target(port)
            if not target:
                time.sleep(0.25)
                continue
            if page_connection is None:
                page_connection = connection_factory(
                    str(target["webSocketDebuggerUrl"]),
                    timeout=3,
                    origin="http://127.0.0.1:{0}".format(port),
                )
                network_video = _capture_video_from_network(
                    page_connection,
                    expected_video_id,
                    timeout_seconds=min(10, timeout_seconds),
                    webpage_url=str(target.get("url") or ""),
                    platform="DOUYIN",
                )
                if network_video:
                    return network_video
            expression = _VIDEO_PAGE_EXPRESSION.replace("__EXPECTED_VIDEO_ID__", json.dumps(expected_video_id))
            result = _cdp(page_connection, 1, "Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            })
            value = ((result.get("result") or {}).get("value") or {})
            download_url = str(value.get("download_url") or "")
            actual_video_id = str(value.get("id") or "")
            if expected_video_id and actual_video_id != expected_video_id:
                time.sleep(0.5)
                continue
            if download_url.startswith(("http://", "https://")):
                return {
                    "id": str(value.get("id") or ""),
                    "title": str(value.get("title") or "短视频"),
                    "uploader": "",
                    "duration": value.get("duration"),
                    "thumbnail": value.get("thumbnail"),
                    "webpage_url": str(value.get("webpage_url") or target.get("url") or ""),
                    "download_url": download_url,
                    "ext": "mp4",
                    "width": value.get("width"),
                    "height": value.get("height"),
                    "format_id": "browser-page",
                    "extractor": "DouyinBrowser",
                    "platform": "DOUYIN",
                    "platform_name": "抖音",
                    "user_agent": str(value.get("user_agent") or ""),
                }
            time.sleep(0.5)
        return None
    except Exception:
        # Cookie authentication should still succeed if the page layout changes.
        # The regular resolver will provide the user-facing extraction error.
        return None
    finally:
        if page_connection:
            page_connection.close()


def _capture_video_from_network(
    connection: Any,
    expected_video_id: str,
    timeout_seconds: float,
    webpage_url: str = "",
    platform: str = "DOUYIN",
) -> Optional[Dict[str, Any]]:
    command_id = 100
    _cdp(connection, command_id, "Network.enable")
    command_id += 1
    _cdp(connection, command_id, "Page.reload", {"ignoreCache": True})
    command_id += 1
    initial = _cdp(connection, command_id, "Runtime.evaluate", {
        "expression": r"""(() => {
          const video = [...document.querySelectorAll('video')].find(item => item.currentSrc || item.src)
            || document.querySelector('video');
          if (video) video.play().catch(() => {});
          const candidates = [
            video && video.currentSrc,
            video && video.src,
            ...(video ? [...video.querySelectorAll('source')].map(item => item.src) : []),
            ...performance.getEntriesByType('resource').map(item => item.name).reverse(),
          ];
          return candidates.find(value => typeof value === 'string' && /^https?:\/\//i.test(value)
            && (/\.mp4(?:\?|$)/i.test(value) || /\.m3u8(?:\?|$)/i.test(value) || /\/video\//i.test(value))) || '';
        })()""",
        "returnByValue": True,
    })
    initial_url = str(((initial.get("result") or {}).get("value") or ""))
    if initial_url.startswith(("http://", "https://")):
        command_id += 1
        return _browser_media_info(
            connection,
            command_id,
            initial_url,
            expected_video_id,
            webpage_url=webpage_url,
            platform=platform,
        )
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            payload = json.loads(connection.recv())
        except Exception as exc:
            if exc.__class__.__name__ in {"WebSocketTimeoutException", "TimeoutError"}:
                continue
            return None
        if payload.get("method") != "Network.responseReceived":
            continue
        params = payload.get("params") or {}
        response = params.get("response") or {}
        raw_response_url = str(response.get("url") or "")
        response_url = raw_response_url.lower()
        mime_type = str(response.get("mimeType") or "").lower()
        resource_type = str(params.get("type") or "").lower()
        if raw_response_url.startswith(("http://", "https://")) and (
            resource_type == "media"
            or mime_type.startswith("video/")
            or "mpegurl" in mime_type
            or ".m3u8" in response_url
        ):
            command_id += 1
            return _browser_media_info(
                connection,
                command_id,
                raw_response_url,
                expected_video_id,
                webpage_url=webpage_url,
                platform=platform,
            )
        if "aweme" not in response_url or not any(marker in response_url for marker in ("detail", "feed")):
            continue
        request_id = str(params.get("requestId") or "")
        if not request_id:
            continue
        command_id += 1
        try:
            body_result = _cdp(connection, command_id, "Network.getResponseBody", {"requestId": request_id})
            body = str(body_result.get("body") or "")
            if body_result.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8", errors="replace")
            data = json.loads(body)
        except Exception:
            continue
        item = _find_aweme_item(data, expected_video_id)
        if not item:
            continue
        video_info = _normalize_browser_aweme(item, expected_video_id)
        if video_info:
            return video_info
    return None


def _browser_media_info(
    connection: Any,
    command_id: int,
    download_url: str,
    video_id: str,
    webpage_url: str = "",
    platform: str = "DOUYIN",
) -> Dict[str, Any]:
    expression = r"""(() => {
          const video = document.querySelector('video');
          return {
            title: (document.title || '').replace(/\s*[-_]\s*(抖音|快手|哔哩哔哩|bilibili).*$/i, '').trim(),
            uploader: document.querySelector('meta[name="author"]')?.content
              || document.querySelector('[class*="author"] [class*="name"]')?.textContent?.trim()
              || '',
            duration: video && Number.isFinite(video.duration) ? video.duration : null,
            thumbnail: (video && video.poster) || document.querySelector('meta[property="og:image"]')?.content || null,
            width: (video && video.videoWidth) || null,
            height: (video && video.videoHeight) || null,
            user_agent: navigator.userAgent,
          };
        })()"""
    value: Dict[str, Any] = {}
    for attempt in range(10):
        result = _cdp(connection, command_id + attempt, "Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
        })
        current = ((result.get("result") or {}).get("value") or {})
        for key, item in current.items():
            if item not in (None, "", 0):
                value[key] = item
        if value.get("width") and value.get("height") and value.get("duration"):
            break
        time.sleep(0.4)
    return {
        "id": video_id,
        "title": str(value.get("title") or "短视频"),
        "uploader": str(value.get("uploader") or ""),
        "duration": value.get("duration"),
        "thumbnail": value.get("thumbnail"),
        "webpage_url": webpage_url or "https://www.douyin.com/video/{0}".format(video_id),
        "download_url": download_url,
        "ext": "mp4",
        "width": value.get("width"),
        "height": value.get("height"),
        "format_id": "browser-media",
        "extractor": "{0}Browser".format(platform.title()),
        "platform": platform,
        "platform_name": {"DOUYIN": "抖音", "KUAISHOU": "快手", "BILIBILI": "哔哩哔哩"}.get(platform, "未知平台"),
        "user_agent": str(value.get("user_agent") or ""),
    }


def _find_aweme_item(value: Any, expected_video_id: str, depth: int = 0) -> Optional[Dict[str, Any]]:
    if depth > 20:
        return None
    if isinstance(value, dict):
        object_id = str(
            value.get("aweme_id")
            or value.get("awemeId")
            or value.get("item_id")
            or value.get("itemId")
            or ""
        )
        if object_id == expected_video_id and isinstance(value.get("video"), dict):
            return value
        for child in value.values():
            found = _find_aweme_item(child, expected_video_id, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_aweme_item(child, expected_video_id, depth + 1)
            if found:
                return found
    return None


def _normalize_browser_aweme(item: Dict[str, Any], video_id: str) -> Optional[Dict[str, Any]]:
    video = item.get("video") or {}
    candidates: List[Tuple[int, str]] = []

    def collect(value: Any, path: str = "", depth: int = 0) -> None:
        if depth > 14:
            return
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            lowered = value.lower()
            if any(marker in lowered for marker in ("/video/tos/", "/tos-cn-ve-", "douyinvod", ".mp4")):
                lowered_path = path.lower()
                score = 0
                if "play_addr_h264" in lowered_path or "playaddrh264" in lowered_path:
                    score += 80
                elif "play_addr" in lowered_path or "playaddr" in lowered_path:
                    score += 60
                elif "download_addr" in lowered_path or "downloadaddr" in lowered_path:
                    score += 40
                if "url_list" in lowered_path or "urllist" in lowered_path:
                    score += 10
                if ".mp4" in lowered:
                    score += 5
                candidates.append((score, value))
            return
        if isinstance(value, dict):
            for key, child in value.items():
                collect(child, "{0}.{1}".format(path, key), depth + 1)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                collect(child, "{0}[{1}]".format(path, index), depth + 1)

    collect(video, "video")
    if not candidates:
        return None
    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    download_url = candidates[0][1]
    duration = video.get("duration")
    try:
        duration = float(duration) if duration is not None else None
        if duration and duration > 10_000:
            duration /= 1000
    except (TypeError, ValueError):
        duration = None
    cover = video.get("cover") or video.get("origin_cover") or video.get("originCover") or {}
    thumbnail = _first_http_url(cover)
    author = item.get("author") or {}
    return {
        "id": video_id,
        "title": str(item.get("desc") or item.get("title") or "短视频"),
        "uploader": str(author.get("nickname") or author.get("unique_id") or author.get("uniqueId") or ""),
        "duration": duration,
        "thumbnail": thumbnail,
        "webpage_url": "https://www.douyin.com/video/{0}".format(video_id),
        "download_url": download_url,
        "ext": "mp4",
        "width": video.get("width"),
        "height": video.get("height"),
        "format_id": "browser-network",
        "extractor": "DouyinBrowser",
        "platform": "DOUYIN",
        "platform_name": "抖音",
        "user_agent": "",
    }


def _first_http_url(value: Any, depth: int = 0) -> Optional[str]:
    if depth > 8:
        return None
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    if isinstance(value, dict):
        for child in value.values():
            found = _first_http_url(child, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _first_http_url(child, depth + 1)
            if found:
                return found
    return None


def _find_douyin_page_target(port: int) -> Optional[Dict[str, Any]]:
    return _find_page_target(port, DOUYIN_HOST_SUFFIXES)


def _find_page_target(port: int, host_suffixes: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
    endpoint = "http://127.0.0.1:{0}/json/list".format(port)
    try:
        with urlopen(endpoint, timeout=1) as response:
            targets = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    for target in targets:
        url = str(target.get("url") or "")
        host = (urlparse(url).hostname or "").lower()
        if target.get("type") == "page" and any(
            host == suffix or host.endswith("." + suffix) for suffix in host_suffixes
        ) and target.get("webSocketDebuggerUrl"):
            return target
    return None


def _platform_video_id(url: str, platform: str) -> str:
    value = str(url or "")
    if platform == "KUAISHOU":
        match = re.search(r"/(?:short-video|photo|s)/([0-9A-Za-z_-]+)", value, re.IGNORECASE)
        if match:
            return match.group(1)
        try:
            query = parse_qs(urlparse(value).query)
            return str((query.get("shareObjectId") or query.get("photoId") or [""])[0])
        except (TypeError, ValueError):
            return ""
    if platform == "BILIBILI":
        match = re.search(r"/(?:video/)?((?:BV)[0-9A-Za-z]+|av\d+)", value, re.IGNORECASE)
        return match.group(1) if match else ""
    return _video_id_from_url(value)


def _video_id_from_url(url: str) -> str:
    value = str(url or "")
    match = re.search(r"/(?:share/)?video/(\d+)", value)
    if match:
        return match.group(1)
    try:
        return str(parse_qs(urlparse(value).query).get("modal_id", [""])[0])
    except (TypeError, ValueError):
        return ""


_VIDEO_PAGE_EXPRESSION = r"""
(() => {
  const expectedVideoId = __EXPECTED_VIDEO_ID__;
  const isHttpVideo = value => typeof value === 'string'
    && /^https?:\/\//i.test(value)
    && (/\.mp4(?:\?|$)/i.test(value) || /\/video\/tos\//i.test(value) || /mime_type=video/i.test(value));
  const video = [...document.querySelectorAll('video')].find(item => item.currentSrc || item.src)
    || document.querySelector('video');
  const pathMatch = location.pathname.match(/\/video\/(\d+)/);
  const modalId = new URLSearchParams(location.search).get('modal_id') || '';
  const pageVideoId = pathMatch ? pathMatch[1] : modalId;
  const directCandidates = video && (!expectedVideoId || pageVideoId === expectedVideoId) ? [
    video.currentSrc,
    video.src,
    ...[...video.querySelectorAll('source')].map(item => item.src),
  ] : [];
  const resourceCandidates = (!expectedVideoId || pageVideoId === expectedVideoId) ? performance.getEntriesByType('resource')
    .map(item => item.name)
    .filter(isHttpVideo)
    .reverse() : [];
  let hydrationCandidates = [];
  const visitUrls = (value, depth = 0) => {
    if (depth > 12 || hydrationCandidates.length > 80 || value == null) return;
    if (typeof value === 'string') {
      if (isHttpVideo(value)) hydrationCandidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visitUrls(item, depth + 1));
      return;
    }
    if (typeof value === 'object') Object.values(value).forEach(item => visitUrls(item, depth + 1));
  };
  const matchingItems = [];
  const findMatchingItems = (value, depth = 0) => {
    if (depth > 14 || value == null || matchingItems.length > 20) return;
    if (Array.isArray(value)) {
      value.forEach(item => findMatchingItems(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const objectId = String(value.aweme_id ?? value.awemeId ?? value.itemId ?? value.item_id ?? '');
    if (expectedVideoId && objectId === expectedVideoId) matchingItems.push(value);
    Object.values(value).forEach(item => findMatchingItems(item, depth + 1));
  };
  for (const script of document.querySelectorAll('script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
    const text = script.textContent || '{}';
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      try { data = JSON.parse(decodeURIComponent(text)); } catch (_) {}
    }
    if (!data) continue;
    if (expectedVideoId) findMatchingItems(data);
    else visitUrls(data);
  }
  matchingItems.forEach(item => visitUrls(item));
  const downloadUrl = [...directCandidates, ...resourceCandidates, ...hydrationCandidates].find(isHttpVideo) || '';
  return {
    id: pageVideoId || expectedVideoId,
    title: (document.title || '').replace(/\s*-\s*抖音.*$/, '').trim() || '短视频',
    duration: video && Number.isFinite(video.duration) ? video.duration : null,
    thumbnail: (video && video.poster) || document.querySelector('meta[property="og:image"]')?.content || null,
    webpage_url: location.href,
    download_url: downloadUrl,
    width: (video && video.videoWidth) || null,
    height: (video && video.videoHeight) || null,
    user_agent: navigator.userAgent,
  };
})()
"""
