import json
import os
import sys
from typing import Any, Dict

from core.protocol import PROTOCOL_VERSION, error, progress, result
from workflows.from_idea import develop_idea
from workflows.from_script import analyze_script
from inputs.douyin_input import DouyinResolverError, detect_video_platform, download_direct_video, download_douyin, probe_douyin_url, resolve_douyin
from inputs.douyin_auth import DouyinAuthError, browser_availability, find_managed_browser, has_managed_profile, login_douyin, managed_cookie_file, resolve_video_in_browser


def dispatch(request: Dict[str, Any]) -> Any:
    request_id = str(request.get("id", "unknown"))
    if request.get("version") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    if request.get("type") != "request":
        raise ValueError("message type must be request")

    method = request.get("method")
    params = request.get("params") or {}
    if method == "workflow.develop_idea":
        return develop_idea(params, lambda value, stage, message: progress(
            request_id, value, stage, message
        ))
    if method == "workflow.analyze_script":
        return analyze_script(params, lambda value, stage, message: progress(
            request_id, value, stage, message
        ))
    if method == "input.resolve_douyin":
        progress(request_id, 0.15, "url_validation", "正在校验视频分享链接")
        target = probe_douyin_url(str(params.get("share_text") or ""))
        data = resolve_douyin(
            str(target["canonical_url"]),
            browser_cookie_source=params.get("browser_cookie_source"),
            cookie_file_path=params.get("cookie_file_path"),
        )
        progress(request_id, 1.0, "completed", "视频地址解析完成")
        return data
    if method == "input.resolve_douyin_auto":
        share_text = str(params.get("share_text") or "")
        target = probe_douyin_url(share_text)
        target_url = str(target["canonical_url"])
        platform = target.get("platform") or detect_video_platform(target_url)
        if platform != "DOUYIN":
            progress(request_id, 0.2, "platform_detected", "已识别视频平台，正在解析公开视频")
            try:
                data = resolve_douyin(target_url)
            except DouyinResolverError:
                if platform != "KUAISHOU":
                    raise
                browser_name, browser_executable = find_managed_browser()
                browser_profile_root = os.path.join(str(params.get("profile_root") or ""), browser_name)
                progress(request_id, 0.45, "browser_resolving", "正在通过专用浏览器读取快手视频")
                data = resolve_video_in_browser(
                    browser_profile_root,
                    browser_name,
                    browser_executable,
                    target_url,
                    platform="KUAISHOU",
                )
            progress(request_id, 1.0, "completed", "视频地址解析完成")
            return data
        profile_root = str(params.get("profile_root") or "").strip()
        if not profile_root:
            raise ValueError("managed browser profile path is required")
        browser_name, browser_executable = find_managed_browser()
        browser_profile_root = os.path.join(profile_root, browser_name)
        profile_path = os.path.join(browser_profile_root, "Default")
        cookie_file_path = managed_cookie_file(browser_profile_root)
        progress(request_id, 0.08, "cookie_validation", "正在验证已保存的平台登录状态")
        if has_managed_profile(browser_profile_root):
            try:
                if os.path.isfile(cookie_file_path):
                    data = resolve_douyin(target_url, cookie_file_path=cookie_file_path)
                else:
                    data = resolve_douyin(
                        target_url,
                        browser_cookie_source=browser_name,
                        browser_profile_path=profile_path,
                    )
                progress(request_id, 1.0, "completed", "视频地址解析完成")
                return data
            except DouyinResolverError as exc:
                if exc.code not in {
                    "DOUYIN_BROWSER_COOKIES_STALE",
                    "DOUYIN_FRESH_COOKIES_REQUIRED",
                    "DOUYIN_BROWSER_COOKIES_FAILED",
                    "DOUYIN_BROWSER_COOKIE_DATABASE_LOCKED",
                    "DOUYIN_BROWSER_PROFILE_NOT_FOUND",
                    "DOUYIN_COOKIE_FILE_STALE",
                    "DOUYIN_COOKIE_FILE_FAILED",
                }:
                    raise
        progress(request_id, 0.2, "browser_verification", "正在通过专用浏览器确认视频可用性和登录状态")
        login_result = login_douyin(
            browser_profile_root,
            browser_name,
            browser_executable,
            target_url=target_url,
        )
        progress(request_id, 0.75, "login_completed", "登录成功，正在解析视频")
        try:
            data = resolve_douyin(
                target_url,
                cookie_file_path=str(login_result["cookie_file_path"]),
            )
        except DouyinResolverError as exc:
            if exc.code != "DOUYIN_COOKIE_FILE_STALE" or not login_result.get("video"):
                raise
            data = login_result["video"]
        progress(request_id, 1.0, "completed", "视频地址解析完成")
        return data
    if method == "input.douyin_browser_availability":
        return browser_availability()
    if method == "input.download_douyin":
        progress(request_id, 0.05, "download_start", "正在准备下载视频")
        target = probe_douyin_url(str(params.get("share_text") or ""))
        data = download_douyin(
            str(target["canonical_url"]),
            str(params.get("output_path") or ""),
            browser_cookie_source=params.get("browser_cookie_source"),
            cookie_file_path=params.get("cookie_file_path"),
        )
        progress(request_id, 1.0, "completed", "视频下载完成")
        return data
    if method == "input.download_douyin_auto":
        share_text = str(params.get("share_text") or "")
        output_path = str(params.get("output_path") or "")
        target = probe_douyin_url(share_text)
        target_url = str(target["canonical_url"])
        platform = target.get("platform") or detect_video_platform(target_url)
        if platform != "DOUYIN":
            progress(request_id, 0.15, "platform_detected", "已识别视频平台，正在下载公开视频")
            try:
                data = download_douyin(target_url, output_path)
            except DouyinResolverError:
                if platform != "KUAISHOU":
                    raise
                browser_name, browser_executable = find_managed_browser()
                browser_profile_root = os.path.join(str(params.get("profile_root") or ""), browser_name)
                progress(request_id, 0.3, "browser_resolving", "正在通过专用浏览器读取快手视频")
                video = resolve_video_in_browser(
                    browser_profile_root,
                    browser_name,
                    browser_executable,
                    target_url,
                    platform="KUAISHOU",
                )
                data = download_direct_video(
                    video,
                    output_path,
                    cookie_file_path=video.get("cookie_file_path"),
                )
            progress(request_id, 1.0, "completed", "视频下载完成")
            return data
        profile_root = str(params.get("profile_root") or "").strip()
        if not profile_root:
            raise ValueError("managed browser profile path is required")
        browser_name, browser_executable = find_managed_browser()
        browser_profile_root = os.path.join(profile_root, browser_name)
        profile_path = os.path.join(browser_profile_root, "Default")
        cookie_file_path = managed_cookie_file(browser_profile_root)
        progress(request_id, 0.05, "download_start", "正在准备下载视频")
        if has_managed_profile(browser_profile_root):
            try:
                if os.path.isfile(cookie_file_path):
                    data = download_douyin(target_url, output_path, cookie_file_path=cookie_file_path)
                else:
                    data = download_douyin(
                        target_url,
                        output_path,
                        browser_cookie_source=browser_name,
                        browser_profile_path=profile_path,
                    )
                progress(request_id, 1.0, "completed", "视频下载完成")
                return data
            except DouyinResolverError as exc:
                if exc.code not in {
                    "DOUYIN_BROWSER_COOKIES_STALE",
                    "DOUYIN_BROWSER_COOKIES_FAILED",
                    "DOUYIN_BROWSER_COOKIE_DATABASE_LOCKED",
                    "DOUYIN_BROWSER_PROFILE_NOT_FOUND",
                    "DOUYIN_COOKIE_FILE_STALE",
                    "DOUYIN_COOKIE_FILE_FAILED",
                }:
                    raise
        progress(request_id, 0.15, "browser_verification", "正在通过专用浏览器确认视频可用性和登录状态")
        login_result = login_douyin(
            browser_profile_root,
            browser_name,
            browser_executable,
            target_url=target_url,
        )
        progress(request_id, 0.3, "download_running", "登录成功，正在下载视频")
        try:
            data = download_douyin(
                target_url,
                output_path,
                cookie_file_path=str(login_result["cookie_file_path"]),
            )
        except DouyinResolverError as exc:
            if exc.code != "DOUYIN_COOKIE_FILE_STALE" or not login_result.get("video"):
                raise
            data = download_direct_video(
                login_result["video"],
                output_path,
                cookie_file_path=str(login_result["cookie_file_path"]),
            )
        progress(request_id, 1.0, "completed", "视频下载完成")
        return data
    if method == "system.ping":
        return {"status": "ok", "protocol_version": PROTOCOL_VERSION}
    raise LookupError("unknown method: {0}".format(method))


def handle_line(line: str) -> None:
    request_id = "unknown"
    try:
        request = json.loads(line)
        request_id = str(request.get("id", request_id))
        result(request_id, dispatch(request))
    except json.JSONDecodeError as exc:
        error(request_id, "INVALID_JSON", str(exc))
    except DouyinResolverError as exc:
        error(request_id, exc.code, str(exc), retryable=exc.retryable)
    except DouyinAuthError as exc:
        error(request_id, exc.code, str(exc), retryable=exc.retryable)
    except ValueError as exc:
        error(request_id, "INVALID_REQUEST", str(exc))
    except LookupError as exc:
        error(request_id, "METHOD_NOT_FOUND", str(exc))
    except Exception as exc:  # Worker boundary: return a protocol error, never corrupt stdout.
        error(request_id, "WORKER_INTERNAL_ERROR", str(exc), retryable=True)


def run() -> None:
    # Rust writes JSONL as UTF-8. Windows otherwise uses the active console
    # code page (often GBK) for redirected standard streams.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    for line in sys.stdin:
        stripped = line.strip()
        if stripped:
            handle_line(stripped)
