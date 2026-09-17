import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from core.engine import dispatch
from inputs.douyin_auth import (
    DouyinAuthError,
    _acquire_profile_session,
    _capture_video_from_network,
    _is_http_video_url,
    _normalize_browser_aweme,
    _profile_session_path,
    _release_profile_session,
    _remove_stale_profile_locks,
    _start_managed_browser,
    _write_netscape_cookie_file,
    browser_availability,
    find_managed_browser,
    has_managed_profile,
    managed_cookie_file,
)
from inputs.douyin_input import DouyinResolverError


class DouyinAuthTests(unittest.TestCase):
    def test_tracking_pixel_query_is_not_treated_as_video(self):
        self.assertFalse(_is_http_video_url(
            "https://sp0.baidu.com/path/s.gif?l=https://www.douyin.com/video/7653460999785303331"
        ))
        self.assertTrue(_is_http_video_url(
            "https://v26-web.douyinvod.com/hash/video/tos/cn/file/?mime_type=video_mp4"
        ))

    def test_douyin_detail_fallback_prefers_h264_play_address(self):
        item = {
            "aweme_id": "7653460999785303331",
            "desc": "长视频",
            "author": {"nickname": "作者"},
            "video": {
                "duration": 380134,
                "width": 1024,
                "height": 576,
                "play_addr": {
                    "url_list": [
                        "https://v11-web.douyinvod.com/default/video/tos/cn/default/?mime_type=video_mp4"
                    ]
                },
                "play_addr_h264": {
                    "url_list": [
                        "https://v26-web.douyinvod.com/h264/video/tos/cn/h264/?mime_type=video_mp4"
                    ]
                },
            },
        }

        result = _normalize_browser_aweme(item, item["aweme_id"])

        self.assertIsNotNone(result)
        self.assertEqual(result["download_url"], item["video"]["play_addr_h264"]["url_list"][0])
        self.assertEqual(len(result["download_urls"]), 2)
        self.assertEqual(result["duration"], 380.134)
        self.assertEqual(result["format_id"], "browser-network")

    def test_network_capture_ignores_tracker_then_uses_douyin_detail(self):
        item = {
            "aweme_id": "7653460999785303331",
            "desc": "长视频",
            "video": {
                "duration": 380134,
                "play_addr_h264": {
                    "url_list": [
                        "https://v26-web.douyinvod.com/h264/video/tos/cn/h264/?mime_type=video_mp4"
                    ]
                },
            },
        }
        connection = Mock()
        connection.recv.side_effect = [
            json.dumps({"id": 100, "result": {}}),
            json.dumps({"id": 101, "result": {}}),
            json.dumps({
                "id": 102,
                "result": {"result": {"value": (
                    "https://sp0.baidu.com/s.gif?l="
                    "https://www.douyin.com/video/7653460999785303331"
                )}},
            }),
            json.dumps({
                "method": "Network.responseReceived",
                "params": {
                    "requestId": "detail-1",
                    "type": "XHR",
                    "response": {
                        "url": (
                            "https://www.douyin.com/aweme/v1/web/aweme/detail/"
                            "?aweme_id=7653460999785303331"
                        ),
                        "mimeType": "application/json",
                    },
                },
            }),
            json.dumps({
                "id": 103,
                "result": {"body": json.dumps({"aweme_detail": item}), "base64Encoded": False},
            }),
        ]

        result = _capture_video_from_network(
            connection,
            item["aweme_id"],
            timeout_seconds=1,
            webpage_url="https://www.douyin.com/video/7653460999785303331",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["download_url"], item["video"]["play_addr_h264"]["url_list"][0])

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.find_managed_browser")
    def test_auto_flow_resolves_non_douyin_without_login(self, find_browser, resolve, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.bilibili.com/video/BV1ab411c7mD",
            "video_id": "BV1ab411c7mD",
            "status": 200,
            "platform": "BILIBILI",
        }
        resolve.return_value = {"id": "BV1ab411c7mD", "platform": "BILIBILI"}
        result = dispatch({
            "version": "1.0",
            "id": "req_bilibili_auto",
            "type": "request",
            "method": "input.resolve_douyin_auto",
            "params": {"share_text": "https://b23.tv/AbCdEf", "profile_root": "C:\\managed-profile"},
        })
        resolve.assert_called_once_with("https://www.bilibili.com/video/BV1ab411c7mD")
        find_browser.assert_not_called()
        self.assertEqual(result["platform"], "BILIBILI")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.find_managed_browser")
    def test_auto_flow_resolves_public_douyin_before_opening_browser(self, find_browser, resolve, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
            "platform": "DOUYIN",
        }
        resolve.return_value = {"id": "123", "download_url": "https://cdn.test/video.mp4"}
        result = dispatch({
            "version": "1.0",
            "id": "req_public_douyin",
            "type": "request",
            "method": "input.resolve_douyin_auto",
            "params": {"share_text": "https://www.douyin.com/video/123", "profile_root": "C:\\managed-profile"},
        })
        resolve.assert_called_once_with("https://www.douyin.com/video/123")
        find_browser.assert_not_called()
        self.assertEqual(result["id"], "123")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.resolve_video_in_browser")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_flow_uses_detail_capture_when_public_extractor_fails(
        self, _find_browser, resolve, browser_resolve, _progress, probe
    ):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
            "platform": "DOUYIN",
        }
        resolve.side_effect = DouyinResolverError("DOUYIN_EXTRACT_FAILED", "failed", retryable=True)
        browser_resolve.return_value = {
            "id": "123",
            "download_url": "https://v26-web.douyinvod.com/video/tos/file/?mime_type=video_mp4",
        }

        result = dispatch({
            "version": "1.0",
            "id": "req_browser_detail",
            "type": "request",
            "method": "input.resolve_douyin_auto",
            "params": {"share_text": "https://www.douyin.com/video/123", "profile_root": "C:\\managed-profile"},
        })

        browser_resolve.assert_called_once_with(
            "C:\\managed-profile\\chrome",
            "chrome",
            "chrome.exe",
            "https://www.douyin.com/video/123",
            platform="DOUYIN",
            timeout_seconds=45,
        )
        self.assertEqual(result["id"], "123")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.download_douyin")
    @patch("core.engine.find_managed_browser")
    def test_auto_downloads_public_douyin_before_opening_browser(self, find_browser, download, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
            "platform": "DOUYIN",
        }
        download.return_value = {"saved_path": "C:\\video.mp4", "size_bytes": 1234}
        result = dispatch({
            "version": "1.0",
            "id": "req_public_douyin_download",
            "type": "request",
            "method": "input.download_douyin_auto",
            "params": {
                "share_text": "https://www.douyin.com/video/123",
                "output_path": "C:\\video.mp4",
                "profile_root": "C:\\managed-profile",
            },
        })
        download.assert_called_once_with("https://www.douyin.com/video/123", "C:\\video.mp4")
        find_browser.assert_not_called()
        self.assertEqual(result["size_bytes"], 1234)

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.download_direct_video")
    @patch("core.engine.resolve_video_in_browser")
    @patch("core.engine.login_douyin")
    @patch("core.engine.download_douyin")
    @patch("core.engine.has_managed_profile", return_value=True)
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_download_refreshes_browser_url_when_ytdlp_gets_no_data_blocks(
        self, _find_browser, _has_profile, download, login, browser_resolve, direct_download, _progress, probe
    ):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
            "platform": "DOUYIN",
        }
        download.side_effect = DouyinResolverError(
            "DOUYIN_DOWNLOAD_NO_DATA",
            "视频平台的下载节点没有继续返回数据，需要刷新视频地址后重试。",
            retryable=True,
        )
        browser_resolve.return_value = {
            "id": "123",
            "cookie_file_path": "C:\\managed-profile\\chrome\\douyin-cookies.txt",
            "download_url": "https://cdn.test/refreshed-video.mp4",
            "webpage_url": "https://www.douyin.com/video/123",
        }
        direct_download.return_value = {"saved_path": "C:\\video.mp4", "size_bytes": 5678}

        result = dispatch({
            "version": "1.0",
            "id": "req_refresh_douyin_download",
            "type": "request",
            "method": "input.download_douyin_auto",
            "params": {
                "share_text": "https://www.douyin.com/video/123",
                "output_path": "C:\\video.mp4",
                "profile_root": "C:\\managed-profile",
            },
        })

        login.assert_not_called()
        direct_download.assert_called_once_with(
            browser_resolve.return_value,
            "C:\\video.mp4",
            cookie_file_path=browser_resolve.return_value["cookie_file_path"],
        )
        self.assertEqual(result["size_bytes"], 5678)

    def test_detects_managed_cookie_database(self):
        with tempfile.TemporaryDirectory() as profile_root:
            network_dir = os.path.join(profile_root, "Default", "Network")
            os.makedirs(network_dir)
            self.assertFalse(has_managed_profile(profile_root))
            with open(os.path.join(network_dir, "Cookies"), "wb") as cookie_database:
                cookie_database.write(b"sqlite")
            self.assertTrue(has_managed_profile(profile_root))

    def test_detects_exported_managed_cookie_file(self):
        with tempfile.TemporaryDirectory() as profile_root:
            self.assertFalse(has_managed_profile(profile_root))
            with open(managed_cookie_file(profile_root), "w", encoding="utf-8") as cookie_file:
                cookie_file.write("# Netscape HTTP Cookie File\n")
            self.assertTrue(has_managed_profile(profile_root))

    def test_exports_douyin_cookies_in_netscape_format(self):
        with tempfile.TemporaryDirectory() as profile_root:
            cookie_path = managed_cookie_file(profile_root)
            _write_netscape_cookie_file(cookie_path, [
                {
                    "name": "sessionid",
                    "value": "secret-value",
                    "domain": ".douyin.com",
                    "path": "/",
                    "secure": True,
                    "expires": 2_000_000_000,
                },
                {"name": "ignored", "value": "x", "domain": ".example.com", "path": "/"},
            ])
            with open(cookie_path, "r", encoding="utf-8") as cookie_file:
                content = cookie_file.read()
            self.assertTrue(content.startswith("# Netscape HTTP Cookie File\n"))
            self.assertIn(".douyin.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tsecret-value", content)
            self.assertNotIn("example.com", content)

    def test_stale_managed_browser_session_is_recovered(self):
        with tempfile.TemporaryDirectory() as profile_root:
            os.makedirs(profile_root, exist_ok=True)
            with open(_profile_session_path(profile_root), "w", encoding="utf-8") as session_file:
                session_file.write('{"token":"old","owner_pid":99999999,"started_at":1}')
            with patch("inputs.douyin_auth._terminate_profile_browser_processes"):
                token = _acquire_profile_session(profile_root, 300)
            self.assertTrue(token)
            _release_profile_session(profile_root, token)
            self.assertFalse(os.path.exists(_profile_session_path(profile_root)))

    def test_active_managed_browser_session_is_not_killed_by_parallel_task(self):
        with tempfile.TemporaryDirectory() as profile_root:
            with open(_profile_session_path(profile_root), "w", encoding="utf-8") as session_file:
                session_file.write('{{"token":"active","owner_pid":{},"started_at":{}}}'.format(os.getpid(), time.time()))
            with self.assertRaises(DouyinAuthError) as context:
                _acquire_profile_session(profile_root, 300)
            self.assertEqual(context.exception.code, "MANAGED_BROWSER_LOGIN_IN_PROGRESS")

    def test_stale_profile_lock_files_are_removed_before_restart(self):
        with tempfile.TemporaryDirectory() as profile_root:
            for name in ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"):
                with open(os.path.join(profile_root, name), "w", encoding="utf-8") as lock_file:
                    lock_file.write("stale")
            _remove_stale_profile_locks(profile_root)
            self.assertFalse(any(os.path.exists(os.path.join(profile_root, name)) for name in ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile")))

    @patch("inputs.douyin_auth.time.sleep")
    @patch("inputs.douyin_auth._remove_stale_profile_locks")
    @patch("inputs.douyin_auth._terminate_profile_browser_processes")
    @patch("inputs.douyin_auth._terminate_browser_process")
    @patch("inputs.douyin_auth._wait_for_debugger")
    @patch("inputs.douyin_auth.subprocess.Popen")
    def test_browser_start_failure_cleans_up_and_retries_once(self, popen, wait_for_debugger, terminate, terminate_profile, remove_locks, _sleep):
        first = Mock(pid=101)
        second = Mock(pid=102)
        popen.side_effect = [first, second]
        wait_for_debugger.side_effect = [
            DouyinAuthError("DOUYIN_BROWSER_START_FAILED", "failed", retryable=True),
            "ws://127.0.0.1:9222/devtools/browser/test",
        ]
        process, websocket_url = _start_managed_browser("C:\\managed-profile", "chrome", "chrome.exe", "https://v.douyin.com")
        self.assertIs(process, second)
        self.assertEqual(websocket_url, "ws://127.0.0.1:9222/devtools/browser/test")
        self.assertEqual(popen.call_count, 2)
        terminate.assert_called_once_with(first)
        terminate_profile.assert_called_once_with("C:\\managed-profile")
        remove_locks.assert_called_once_with("C:\\managed-profile")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.resolve_video_in_browser")
    @patch("core.engine.login_douyin")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.has_managed_profile", return_value=False)
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_flow_logs_in_then_resolves(self, _find_browser, _has_profile, resolve, login, browser_resolve, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
        }
        resolve.side_effect = [
            DouyinResolverError("DOUYIN_FRESH_COOKIES_REQUIRED", "login required", retryable=True),
            {"id": "123", "download_url": "https://cdn.test/video.mp4"},
        ]
        browser_resolve.side_effect = DouyinAuthError("DOUYIN_BROWSER_AUTH_REQUIRED", "login required", retryable=True)
        login.return_value = {"cookie_file_path": "C:\\managed-profile\\chrome\\douyin-cookies.txt"}
        result = dispatch({
            "version": "1.0",
            "id": "req_auto",
            "type": "request",
            "method": "input.resolve_douyin_auto",
            "params": {"share_text": "https://www.douyin.com/video/123", "profile_root": "C:\\managed-profile"},
        })
        login.assert_called_once_with(
            "C:\\managed-profile\\chrome",
            "chrome",
            "chrome.exe",
            target_url="https://www.douyin.com/video/123",
        )
        resolve.assert_called_with(
            "https://www.douyin.com/video/123",
            cookie_file_path="C:\\managed-profile\\chrome\\douyin-cookies.txt",
        )
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(result["id"], "123")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.resolve_video_in_browser")
    @patch("core.engine.login_douyin")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.has_managed_profile", return_value=True)
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_flow_reauthenticates_stale_cookie(self, _find_browser, _has_profile, resolve, login, browser_resolve, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
        }
        login.return_value = {"cookie_file_path": "C:\\managed-profile\\chrome\\douyin-cookies.txt"}
        resolve.side_effect = [
            DouyinResolverError("DOUYIN_FRESH_COOKIES_REQUIRED", "login required", retryable=True),
            DouyinResolverError("DOUYIN_BROWSER_COOKIES_STALE", "stale", retryable=True),
            {"id": "123", "download_url": "https://cdn.test/video.mp4"},
        ]
        browser_resolve.side_effect = DouyinAuthError("DOUYIN_BROWSER_AUTH_REQUIRED", "login required", retryable=True)
        result = dispatch({
            "version": "1.0",
            "id": "req_auto",
            "type": "request",
            "method": "input.resolve_douyin_auto",
            "params": {"share_text": "https://www.douyin.com/video/123", "profile_root": "C:\\managed-profile"},
        })
        login.assert_called_once_with(
            "C:\\managed-profile\\chrome",
            "chrome",
            "chrome.exe",
            target_url="https://www.douyin.com/video/123",
        )
        self.assertEqual(resolve.call_count, 3)
        self.assertEqual(result["id"], "123")

    @patch("inputs.douyin_auth.find_edge", return_value="msedge.exe")
    @patch("inputs.douyin_auth.find_chrome", return_value=None)
    def test_falls_back_to_edge_when_chrome_is_missing(self, _find_chrome, _find_edge):
        self.assertEqual(find_managed_browser(), ("edge", "msedge.exe"))

    @patch("inputs.douyin_auth.find_edge", return_value="msedge.exe")
    @patch("inputs.douyin_auth._login_douyin_once")
    def test_falls_back_to_edge_when_chrome_cannot_start(self, login_once, _find_edge):
        from inputs.douyin_auth import login_douyin
        login_once.side_effect = [
            DouyinAuthError("DOUYIN_BROWSER_START_FAILED", "chrome failed", retryable=True),
            {"authenticated": True, "browser": "edge"},
        ]
        result = login_douyin(
            "C:\\managed-profile\\chrome",
            "chrome",
            "chrome.exe",
            target_url="https://www.douyin.com/video/123",
        )
        self.assertEqual(result["browser"], "edge")
        login_once.assert_called_with(
            "C:\\managed-profile\\edge",
            "edge",
            "msedge.exe",
            "https://www.douyin.com/video/123",
            300,
        )

    @patch("inputs.douyin_auth.find_edge", return_value=None)
    @patch("inputs.douyin_auth.find_chrome", return_value=None)
    def test_reports_when_no_managed_browser_is_installed(self, _find_chrome, _find_edge):
        self.assertEqual(browser_availability(), {
            "chrome": False,
            "edge": False,
            "can_auto_login": False,
            "preferred": None,
        })


if __name__ == "__main__":
    unittest.main()
