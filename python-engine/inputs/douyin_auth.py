import json
import base64
import os
import re
import socket
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen


AUTH_COOKIE_NAMES = {"sessionid", "sessionid_ss"}
FRESH_COOKIE_NAMES = {"s_v_web_id", "ttwid"}
DOUYIN_HOST_SUFFIXES = ("douyin.com", "iesdouyin.com")
DOUYIN_DETAIL_ENDPOINTS = (
    "/aweme/v1/web/aweme/detail/",
    "/aweme/v2/web/aweme/detail/",
    "/web/api/v2/aweme/iteminfo",
)
DOUYIN_DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)
PLATFORM_BROWSER_HOSTS = {
    "DOUYIN": DOUYIN_HOST_SUFFIXES,
    "KUAISHOU": ("kuaishou.com", "gifshow.com", "kwai.com"),
    "BILIBILI": ("bilibili.com", "b23.tv"),
}
MANAGED_COOKIE_FILE_NAME = "douyin-cookies.txt"
MANAGED_BROWSER_SESSION_FILE = ".aivs-browser-session.json"


class DouyinAuthError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _process_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _profile_session_path(profile_root: str) -> str:
    return os.path.join(profile_root, MANAGED_BROWSER_SESSION_FILE)


def _terminate_profile_browser_processes(profile_root: str) -> None:
    """Stop only Chrome/Edge processes using this app-owned profile."""
    if os.name != "nt":
        return
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    powershell = os.path.join(
        system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    )
    if not os.path.isfile(powershell):
        powershell = "powershell.exe"
    script = (
        "$profile=$env:AIVS_MANAGED_BROWSER_PROFILE;"
        "$needle='--user-data-dir='+$profile;"
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" "
        "-ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and "
        "$_.CommandLine.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    environment = os.environ.copy()
    environment["AIVS_MANAGED_BROWSER_PROFILE"] = os.path.abspath(profile_root)
    try:
        subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        # The PID-based process-tree cleanup below remains available even when
        # WMI or PowerShell is disabled by an enterprise policy.
        pass


def _remove_stale_profile_locks(profile_root: str) -> None:
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"):
        path = os.path.join(profile_root, name)
        try:
            if os.path.lexists(path):
                os.unlink(path)
        except OSError:
            pass


def _acquire_profile_session(profile_root: str, timeout_seconds: int) -> str:
    os.makedirs(profile_root, exist_ok=True)
    session_path = _profile_session_path(profile_root)
    token = uuid.uuid4().hex
    for _ in range(3):
        try:
            descriptor = os.open(session_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            try:
                with open(session_path, "r", encoding="utf-8") as session_file:
                    existing = json.load(session_file)
                owner_pid = int(existing.get("owner_pid") or 0)
                started_at = float(existing.get("started_at") or 0)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                owner_pid = 0
                started_at = 0
            if _process_is_running(owner_pid) and time.time() - started_at < timeout_seconds + 90:
                raise DouyinAuthError(
                    "MANAGED_BROWSER_LOGIN_IN_PROGRESS",
                    "另一个视频任务正在等待平台登录，请先在已打开的专用浏览器中完成登录",
                    retryable=True,
                )
            _terminate_profile_browser_processes(profile_root)
            try:
                os.unlink(session_path)
            except OSError:
                pass
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as session_file:
            json.dump(
                {"token": token, "owner_pid": os.getpid(), "started_at": time.time()},
                session_file,
            )
        _terminate_profile_browser_processes(profile_root)
        _remove_stale_profile_locks(profile_root)
        return token
    raise DouyinAuthError(
        "MANAGED_BROWSER_SESSION_BUSY",
        "专用浏览器登录会话仍被占用，请关闭已打开的专用登录窗口后重试",
        retryable=True,
    )


def _release_profile_session(profile_root: str, token: str) -> None:
    session_path = _profile_session_path(profile_root)
    try:
        with open(session_path, "r", encoding="utf-8") as session_file:
            existing = json.load(session_file)
        if existing.get("token") == token:
            os.unlink(session_path)
    except (OSError, json.JSONDecodeError):
        pass


def _terminate_browser_process(process: Optional[subprocess.Popen]) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            pass
    if process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass


def _start_managed_browser(
    profile_root: str,
    browser_name: str,
    browser_executable: str,
    target_url: str,
    headless: bool = False,
) -> Tuple[subprocess.Popen, str]:
    arguments = [
        browser_executable,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port={0}".format(_free_port()),
        "--remote-allow-origins=*",
        "--user-data-dir={0}".format(profile_root),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-mode",
        "--no-service-autorun",
    ]
    if headless:
        arguments.extend([
            "--headless=new",
            "--window-size=1440,900",
            "--lang=zh-CN",
            "--disable-blink-features=AutomationControlled",
            "--user-agent={0}".format(DOUYIN_DESKTOP_USER_AGENT),
        ])
    else:
        arguments.append("--new-window")
    arguments.append(target_url)
    port = int(arguments[2].split("=", 1)[1])
    last_error: Optional[DouyinAuthError] = None
    for attempt in range(2):
        process: Optional[subprocess.Popen] = None
        try:
            creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
            process = subprocess.Popen(
                arguments,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags,
            )
            return process, _wait_for_debugger(port, process, 20, browser_name)
        except OSError as exc:
            last_error = DouyinAuthError(
                "DOUYIN_BROWSER_EXEC_FAILED",
                "无法启动{0}登录窗口：{1}".format(browser_name.title(), exc),
                retryable=True,
            )
        except DouyinAuthError as exc:
            last_error = exc
        _terminate_browser_process(process)
        _terminate_profile_browser_processes(profile_root)
        _remove_stale_profile_locks(profile_root)
        if attempt == 0:
            time.sleep(0.8)
    assert last_error is not None
    raise last_error


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
        return _login_douyin_once(
            profile_root,
            browser_name,
            browser_executable,
            target_url,
            timeout_seconds,
        )
    except DouyinAuthError as exc:
        startup_errors = {
            "DOUYIN_BROWSER_EXEC_FAILED",
            "DOUYIN_BROWSER_START_FAILED",
            "DOUYIN_BROWSER_DEBUG_TIMEOUT",
        }
        if browser_name != "chrome" or exc.code not in startup_errors:
            raise
        edge_executable = find_edge()
        if not edge_executable:
            raise
        edge_profile_root = os.path.join(os.path.dirname(profile_root), "edge")
        return _login_douyin_once(
            edge_profile_root,
            "edge",
            edge_executable,
            target_url,
            timeout_seconds,
        )


def _login_douyin_once(
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
    session_token = _acquire_profile_session(profile_root, timeout_seconds)
    login_started_at = time.time()
    process: Optional[subprocess.Popen] = None
    connection = None
    try:
        process, websocket_url = _start_managed_browser(
            profile_root, browser_name, browser_executable, target_url
        )
        port = int(urlparse(websocket_url).port or 0)
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
            page_target = _find_douyin_page_target(port, expected_video_id)
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
        _terminate_browser_process(process)
        _terminate_profile_browser_processes(profile_root)
        _remove_stale_profile_locks(profile_root)
        _release_profile_session(profile_root, session_token)


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
        return _resolve_video_in_browser_once(
            profile_root,
            browser_name,
            browser_executable,
            target_url,
            platform,
            timeout_seconds,
        )
    except DouyinAuthError as exc:
        startup_errors = {
            "DOUYIN_BROWSER_EXEC_FAILED",
            "DOUYIN_BROWSER_START_FAILED",
            "DOUYIN_BROWSER_DEBUG_TIMEOUT",
        }
        if browser_name != "chrome" or exc.code not in startup_errors:
            raise
        edge_executable = find_edge()
        if not edge_executable:
            raise
        return _resolve_video_in_browser_once(
            os.path.join(os.path.dirname(profile_root), "edge"),
            "edge",
            edge_executable,
            target_url,
            platform,
            timeout_seconds,
        )


def resolve_public_douyin(
    browser_name: str,
    browser_executable: str,
    target_url: str,
    timeout_seconds: int = 45,
) -> Dict[str, Any]:
    """Resolve one public Douyin item in an isolated, headless browser profile.

    The resolver intentionally accepts only an aweme detail response whose id
    matches the id in ``target_url``.  It never falls back to a DOM ``video``
    element or an arbitrary media response because Douyin pages can preload
    recommendation clips that do not belong to the requested item.
    """
    expected_video_id = _video_id_from_url(target_url)
    if not expected_video_id:
        raise DouyinAuthError(
            "DOUYIN_VIDEO_ID_MISSING",
            "分享链接没有解析出目标作品 ID，无法确认视频内容是否一致",
            retryable=True,
        )
    try:
        return _resolve_public_douyin_once(
            browser_name,
            browser_executable,
            target_url,
            expected_video_id,
            timeout_seconds,
        )
    except DouyinAuthError as exc:
        startup_errors = {
            "DOUYIN_BROWSER_EXEC_FAILED",
            "DOUYIN_BROWSER_START_FAILED",
            "DOUYIN_BROWSER_DEBUG_TIMEOUT",
        }
        if browser_name != "chrome" or exc.code not in startup_errors:
            raise
        edge_executable = find_edge()
        if not edge_executable:
            raise
        return _resolve_public_douyin_once(
            "edge",
            edge_executable,
            target_url,
            expected_video_id,
            timeout_seconds,
        )


def _resolve_public_douyin_once(
    browser_name: str,
    browser_executable: str,
    target_url: str,
    expected_video_id: str,
    timeout_seconds: int,
) -> Dict[str, Any]:
    try:
        from websocket import create_connection
    except ImportError:
        raise DouyinAuthError(
            "VIDEO_CDP_DEPENDENCY_MISSING",
            "缺少 websocket-client，无法通过浏览器读取视频",
            retryable=True,
        )
    process: Optional[subprocess.Popen] = None
    page_connection = None
    with tempfile.TemporaryDirectory(prefix="aivs_douyin_public_") as profile_root:
        try:
            process, browser_websocket_url = _start_managed_browser(
                profile_root,
                browser_name,
                browser_executable,
                "https://www.douyin.com/",
                headless=True,
            )
            port = int(urlparse(browser_websocket_url).port or 0)
            warm_deadline = time.time() + min(8, timeout_seconds)
            target = None
            while time.time() < warm_deadline:
                if process.poll() is not None:
                    raise DouyinAuthError(
                        "DOUYIN_BROWSER_START_FAILED",
                        "无界面浏览器启动后意外退出",
                        retryable=True,
                    )
                target = _find_page_target(port, DOUYIN_HOST_SUFFIXES)
                if target:
                    break
                time.sleep(0.2)
            if not target:
                raise DouyinAuthError(
                    "DOUYIN_BROWSER_DEBUG_TIMEOUT",
                    "无界面浏览器未能打开抖音页面",
                    retryable=True,
                )
            page_connection = create_connection(
                str(target["webSocketDebuggerUrl"]),
                timeout=3,
                origin="http://127.0.0.1:{0}".format(port),
            )
            # Match the reference resolver: warm the origin first, then listen
            # before navigating to the exact /video/{aweme_id} page.
            time.sleep(2)
            exact_url = "https://www.douyin.com/video/{0}".format(expected_video_id)
            capture_timeout = max(3, (timeout_seconds - 2) / 2)
            video = _capture_video_from_network(
                page_connection,
                expected_video_id,
                timeout_seconds=capture_timeout,
                webpage_url=exact_url,
                platform="DOUYIN",
                navigate_url=exact_url,
            )
            if not video:
                video = _capture_video_from_network(
                    page_connection,
                    expected_video_id,
                    timeout_seconds=capture_timeout,
                    webpage_url=exact_url,
                    platform="DOUYIN",
                )
            if not video or str(video.get("id") or "") != expected_video_id:
                raise DouyinAuthError(
                    "DOUYIN_DETAIL_NOT_FOUND",
                    "没有捕获到目标作品的详情数据，可能需要登录或安全验证",
                    retryable=True,
                )
            return video
        finally:
            if page_connection:
                page_connection.close()
            _terminate_browser_process(process)
            _terminate_profile_browser_processes(profile_root)
            _remove_stale_profile_locks(profile_root)


def _resolve_video_in_browser_once(
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
    session_token = _acquire_profile_session(profile_root, timeout_seconds)
    process: Optional[subprocess.Popen] = None
    browser_connection = None
    page_connection = None
    try:
        process, browser_websocket_url = _start_managed_browser(
            profile_root, browser_name, browser_executable, target_url
        )
        port = int(urlparse(browser_websocket_url).port or 0)
        expected_video_id = _platform_video_id(target_url, platform)
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if process.poll() is not None:
                raise DouyinAuthError("VIDEO_BROWSER_CANCELLED", "专用浏览器窗口已关闭，尚未读取到可播放视频", retryable=True)
            target = _find_page_target(
                port,
                host_suffixes,
                expected_video_id if platform == "DOUYIN" else "",
            )
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
            video = _capture_video_from_network(
                page_connection,
                expected_video_id,
                timeout_seconds=min(18, max(3, deadline - time.time())),
                webpage_url=target_url,
                platform=platform,
            )
            if video and (not expected_video_id or str(video.get("id") or "") == expected_video_id):
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
        _terminate_browser_process(process)
        _terminate_profile_browser_processes(profile_root)
        _remove_stale_profile_locks(profile_root)
        _release_profile_session(profile_root, session_token)


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


def _wait_for_debugger(
    port: int,
    process: subprocess.Popen,
    timeout_seconds: int,
    browser_name: str = "browser",
) -> str:
    deadline = time.time() + timeout_seconds
    endpoint = "http://127.0.0.1:{0}/json/version".format(port)
    while time.time() < deadline:
        if process.poll() is not None:
            raise DouyinAuthError(
                "DOUYIN_BROWSER_START_FAILED",
                "{0}登录窗口启动失败，已自动清理残留进程并重试".format(browser_name.title()),
                retryable=True,
            )
        try:
            with urlopen(endpoint, timeout=1) as response:
                payload = json.loads(response.read().decode("utf-8"))
            websocket_url = payload.get("webSocketDebuggerUrl")
            if websocket_url:
                return str(websocket_url)
        except Exception:
            time.sleep(0.2)
    raise DouyinAuthError(
        "DOUYIN_BROWSER_DEBUG_TIMEOUT",
        "无法连接专用{0}登录窗口，已自动清理残留进程并重试".format(browser_name.title()),
        retryable=True,
    )


def _cdp(connection: Any, command_id: int, method: str, params: Optional[Dict[str, Any]] = None, events: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"id": command_id, "method": method}
    if params:
        payload["params"] = params
    connection.send(json.dumps(payload))
    while True:
        payload = json.loads(connection.recv())
        if payload.get("id") != command_id:
            if events is not None and payload.get("method"):
                events.append(payload)
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
    lines = ["# Netscape HTTP Cookie File", "# Generated by 逐梦帧; contains sensitive login data."]
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
            target = _find_douyin_page_target(port, expected_video_id)
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
            # Never attach the page ID to an unrelated DOM/preloaded video.
            return None
        return None
    except DouyinAuthError:
        raise
    except Exception:
        return None
    finally:
        if page_connection:
            page_connection.close()


def _is_http_video_url(value: Any) -> bool:
    """Accept only URLs that describe media, never tracker/image URLs with video text in a query."""
    if not isinstance(value, str) or not value.startswith(("http://", "https://")):
        return False
    try:
        parsed = urlparse(value)
        path = parsed.path.lower()
        query = parse_qs(parsed.query)
    except (TypeError, ValueError):
        return False
    if path.endswith((".gif", ".jpg", ".jpeg", ".png", ".webp", ".svg", ".ico")):
        return False
    if path.endswith((".mp4", ".m3u8", ".m4s", ".webm", ".flv")):
        return True
    mime_type = str((query.get("mime_type") or query.get("mime") or [""])[0]).lower()
    if mime_type.startswith("video"):
        return True
    if any(marker in path for marker in ("/video/tos/", "/tos-cn-ve-")):
        return True
    host = (parsed.hostname or "").lower()
    if (host == "douyinvod.com" or host.endswith(".douyinvod.com")) and "/video/" in path:
        return True
    return (
        (host == "douyin.com" or host.endswith(".douyin.com"))
        and "/aweme/v1/play/" in path
        and bool(query.get("video_id"))
    )


def _capture_video_from_network(
    connection: Any,
    expected_video_id: str,
    timeout_seconds: float,
    webpage_url: str = "",
    platform: str = "DOUYIN",
    navigate_url: str = "",
) -> Optional[Dict[str, Any]]:
    command_id = 100
    events: List[Dict[str, Any]] = []
    _cdp(connection, command_id, "Network.enable", events=events)
    command_id += 1
    if navigate_url:
        _cdp(connection, command_id, "Page.navigate", {"url": navigate_url}, events=events)
    else:
        _cdp(connection, command_id, "Page.reload", {"ignoreCache": True}, events=events)
    command_id += 1
    if platform == "DOUYIN":
        if not expected_video_id:
            return None
        return _capture_douyin_detail_response(
            connection,
            command_id,
            expected_video_id,
            timeout_seconds,
            events=events,
        )
    initial = _cdp(connection, command_id, "Runtime.evaluate", {
        "expression": r"""(() => {
          const isHttpVideo = value => {
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
            try {
              const url = new URL(value);
              const path = url.pathname.toLowerCase();
              if (/\.(gif|jpe?g|png|webp|svg|ico)$/i.test(path)) return false;
              return /\.(mp4|m3u8|m4s|webm|flv)$/i.test(path)
                || path.includes('/video/tos/')
                || path.includes('/tos-cn-ve-')
                || ((url.hostname === 'douyinvod.com' || url.hostname.endsWith('.douyinvod.com'))
                  && path.includes('/video/'))
                || (/^video/i.test(url.searchParams.get('mime_type') || url.searchParams.get('mime') || ''))
                || ((url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))
                  && path.includes('/aweme/v1/play/') && url.searchParams.has('video_id'));
            } catch (_) {
              return false;
            }
          };
          const video = [...document.querySelectorAll('video')].find(item => item.currentSrc || item.src)
            || document.querySelector('video');
          if (video) video.play().catch(() => {});
          const candidates = [
            video && video.currentSrc,
            video && video.src,
            ...(video ? [...video.querySelectorAll('source')].map(item => item.src) : []),
            ...performance.getEntriesByType('resource').map(item => item.name).reverse(),
          ];
          return candidates.find(isHttpVideo) || '';
        })()""",
        "returnByValue": True,
    })
    initial_url = str(((initial.get("result") or {}).get("value") or ""))
    if _is_http_video_url(initial_url):
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
    return None


def _capture_douyin_detail_response(
    connection: Any,
    command_id: int,
    expected_video_id: str,
    timeout_seconds: float,
    events: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """Capture completed detail bodies; retain events interleaved with CDP replies."""
    events = events if events is not None else []
    pending: Dict[str, str] = {}
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            payload = events.pop(0) if events else json.loads(connection.recv())
        except Exception as exc:
            if exc.__class__.__name__ in {"WebSocketTimeoutException", "TimeoutError"}:
                continue
            return None
        params = payload.get("params") or {}
        request_id = str(params.get("requestId") or "")
        method = payload.get("method")
        if method == "Network.responseReceived":
            response = params.get("response") or {}
            url = str(response.get("url") or "")
            parsed = urlparse(url)
            host = (parsed.hostname or "").lower()
            if (any(host == suffix or host.endswith("." + suffix) for suffix in DOUYIN_HOST_SUFFIXES)
                    and any(marker in parsed.path for marker in DOUYIN_DETAIL_ENDPOINTS)
                    and request_id):
                pending[request_id] = url
            continue
        if method == "Network.loadingFailed":
            pending.pop(request_id, None)
            continue
        if method != "Network.loadingFinished" or request_id not in pending:
            continue
        response_url = pending.pop(request_id)
        command_id += 1
        try:
            body_result = _cdp(connection, command_id, "Network.getResponseBody",
                               {"requestId": request_id}, events=events)
            body = str(body_result.get("body") or "")
            if body_result.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8", errors="replace")
            data = json.loads(body)
        except Exception:
            continue
        item = _find_aweme_item(data, expected_video_id)
        if item:
            video_info = _normalize_browser_aweme(item, expected_video_id)
            if video_info:
                return video_info
        if isinstance(data, dict) and data.get("filter_detail") and not item:
            detail = data["filter_detail"]
            filtered_id = str(detail.get("aweme_id") or "") if isinstance(detail, dict) else ""
            if filtered_id == expected_video_id or (not filtered_id and _video_id_from_url(response_url) == expected_video_id):
                raise DouyinAuthError("DOUYIN_VIDEO_UNAVAILABLE", "抖音返回目标作品不可用，可能已删除或设为私密")
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
    candidates: List[Tuple[int, int, int, int, str]] = []

    def add_address(node: Any, priority: int) -> None:
        if not isinstance(node, dict):
            return
        urls = node.get("url_list") or node.get("urlList") or node.get("download_url_list") or []
        if not isinstance(urls, list):
            return
        try:
            width = int(node.get("width") or 0)
            height = int(node.get("height") or 0)
        except (TypeError, ValueError):
            width = 0
            height = 0
        try:
            size = int(node.get("data_size") or node.get("dataSize") or 0)
        except (TypeError, ValueError):
            size = 0
        # Each rendition can list several equivalent CDN mirrors. Match the
        # reference resolver and keep only the first mirror for that rendition.
        url = next((value for value in urls if _is_http_video_url(value)), None)
        if url:
            candidates.append((height, width, size, priority, url))

    # Prefer the structured play addresses exposed by Douyin's aweme detail API.
    # This mirrors the proven fallback in douyin_analysis and avoids unrelated
    # performance resources from the page entirely.
    add_address(video.get("play_addr_h264") or video.get("playAddrH264"), 500)
    add_address(video.get("play_addr") or video.get("playAddr"), 450)
    for bitrate in video.get("bit_rate") or video.get("bitRate") or []:
        if isinstance(bitrate, dict):
            add_address(bitrate.get("play_addr") or bitrate.get("playAddr"), 400)
    add_address(video.get("play_addr_265") or video.get("playAddr265"), 300)
    add_address(video.get("download_addr") or video.get("downloadAddr"), 200)

    def collect(value: Any, path: str = "", depth: int = 0) -> None:
        if depth > 14:
            return
        if isinstance(value, str) and _is_http_video_url(value):
            lowered_path = path.lower()
            score = 0
            if "play_addr_h264" in lowered_path or "playaddrh264" in lowered_path:
                score += 500
            elif "play_addr" in lowered_path or "playaddr" in lowered_path:
                score += 450
            elif "bit_rate" in lowered_path or "bitrate" in lowered_path:
                score += 400
            elif "download_addr" in lowered_path or "downloadaddr" in lowered_path:
                score += 200
            candidates.append((0, 0, 0, score, value))
            return
        if isinstance(value, dict):
            for key, child in value.items():
                collect(child, "{0}.{1}".format(path, key), depth + 1)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                collect(child, "{0}[{1}]".format(path, index), depth + 1)

    if not candidates:
        collect(video, "video")
    if not candidates:
        return None
    # Prefer the largest rendition; codec/address kind is only a tie breaker.
    candidates.sort(key=lambda candidate: candidate[:4], reverse=True)
    download_urls = []
    for candidate in candidates:
        if candidate[4] not in download_urls:
            download_urls.append(candidate[4])
    download_url = download_urls[0]
    duration = video.get("duration")
    try:
        duration = float(duration) if duration is not None else None
        # The aweme detail schema stores this field in milliseconds even for
        # clips shorter than ten seconds. Threshold conversion would turn a
        # three-second value (3000) into a fictitious 3000-second video.
        if duration and duration > 0:
            duration /= 1000
        else:
            duration = None
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
        "download_urls": download_urls,
        "filesize": candidates[0][2] or None,
        "ext": "mp4",
        "width": video.get("width"),
        "height": video.get("height"),
        "format_id": "browser-network",
        "extractor": "DouyinBrowser",
        "platform": "DOUYIN",
        "platform_name": "抖音",
        "user_agent": DOUYIN_DESKTOP_USER_AGENT,
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


def _find_douyin_page_target(port: int, expected_video_id: str = "") -> Optional[Dict[str, Any]]:
    return _find_page_target(port, DOUYIN_HOST_SUFFIXES, expected_video_id)


def _find_page_target(
    port: int,
    host_suffixes: Tuple[str, ...],
    expected_video_id: str = "",
) -> Optional[Dict[str, Any]]:
    endpoint = "http://127.0.0.1:{0}/json/list".format(port)
    try:
        with urlopen(endpoint, timeout=1) as response:
            targets = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    matching_targets = []
    for target in targets:
        url = str(target.get("url") or "")
        host = (urlparse(url).hostname or "").lower()
        if target.get("type") == "page" and any(
            host == suffix or host.endswith("." + suffix) for suffix in host_suffixes
        ) and target.get("webSocketDebuggerUrl"):
            matching_targets.append(target)
    if expected_video_id:
        for target in matching_targets:
            if _platform_video_id(str(target.get("url") or ""), "DOUYIN") == expected_video_id:
                return target
        return None
    return matching_targets[0] if matching_targets else None


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
    from inputs.douyin_input import _video_id
    return _video_id(url, "DOUYIN")
