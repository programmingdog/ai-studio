import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from core.engine import dispatch
from inputs.douyin_auth import _write_netscape_cookie_file, browser_availability, find_managed_browser, has_managed_profile, managed_cookie_file
from inputs.douyin_input import DouyinResolverError


class DouyinAuthTests(unittest.TestCase):
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

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.login_douyin")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.has_managed_profile", return_value=False)
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_flow_logs_in_then_resolves(self, _find_browser, _has_profile, resolve, login, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
        }
        resolve.return_value = {"id": "123", "download_url": "https://cdn.test/video.mp4"}
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
        resolve.assert_called_once_with(
            "https://www.douyin.com/video/123",
            cookie_file_path="C:\\managed-profile\\chrome\\douyin-cookies.txt",
        )
        self.assertEqual(result["id"], "123")

    @patch("core.engine.probe_douyin_url")
    @patch("core.engine.progress")
    @patch("core.engine.login_douyin")
    @patch("core.engine.resolve_douyin")
    @patch("core.engine.has_managed_profile", return_value=True)
    @patch("core.engine.find_managed_browser", return_value=("chrome", "chrome.exe"))
    def test_auto_flow_reauthenticates_stale_cookie(self, _find_browser, _has_profile, resolve, login, _progress, probe):
        probe.return_value = {
            "canonical_url": "https://www.douyin.com/video/123",
            "video_id": "123",
            "status": 200,
        }
        login.return_value = {"cookie_file_path": "C:\\managed-profile\\chrome\\douyin-cookies.txt"}
        resolve.side_effect = [
            DouyinResolverError("DOUYIN_BROWSER_COOKIES_STALE", "stale", retryable=True),
            {"id": "123", "download_url": "https://cdn.test/video.mp4"},
        ]
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
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(result["id"], "123")

    @patch("inputs.douyin_auth.find_edge", return_value="msedge.exe")
    @patch("inputs.douyin_auth.find_chrome", return_value=None)
    def test_falls_back_to_edge_when_chrome_is_missing(self, _find_chrome, _find_edge):
        self.assertEqual(find_managed_browser(), ("edge", "msedge.exe"))

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
