import json
import os
import subprocess
import sys
import tempfile
import unittest
from urllib.error import HTTPError

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from inputs.douyin_input import DouyinResolverError, detect_video_platform, download_douyin, extract_douyin_url, probe_douyin_url, resolve_douyin


class DouyinInputTests(unittest.TestCase):
    def test_reports_deleted_video_before_cookie_login(self):
        canonical_url = "https://www.douyin.com/video/7674253884752037282"

        def opener(*_args, **_kwargs):
            raise HTTPError(canonical_url, 404, "Not Found", None, None)

        with self.assertRaises(DouyinResolverError) as context:
            probe_douyin_url("https://v.douyin.com/yANCEV5S8Nk/", opener=opener)
        self.assertEqual(context.exception.code, "DOUYIN_VIDEO_UNAVAILABLE")
        self.assertIn("已删除", str(context.exception))

    def test_returns_canonical_video_id_from_short_link(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def geturl(self):
                return "https://www.douyin.com/video/1234567890?previous_page=app_code_link"

        result = probe_douyin_url("https://v.douyin.com/AbCdEf/", opener=lambda *_args, **_kwargs: Response())
        self.assertEqual(result["video_id"], "1234567890")
        self.assertEqual(result["status"], 200)

    def test_extracts_short_url_from_share_text(self):
        text = "复制此链接，打开抖音搜索，看看TA的作品 https://v.douyin.com/AbCdEf/ 8@3.com"
        self.assertEqual(extract_douyin_url(text), "https://v.douyin.com/AbCdEf/")

    def test_recognizes_supported_platform_share_links(self):
        cases = (
            ("3.21 复制打开 https://v.kuaishou.com/AbCdEf/ 看视频", "https://v.kuaishou.com/AbCdEf/", "KUAISHOU"),
            ("分享视频 https://www.kuaishou.com/short-video/3xabc123", "https://www.kuaishou.com/short-video/3xabc123", "KUAISHOU"),
            ("【视频】https://b23.tv/AbCdEf", "https://b23.tv/AbCdEf", "BILIBILI"),
            ("https://www.bilibili.com/video/BV1ab411c7mD", "https://www.bilibili.com/video/BV1ab411c7mD", "BILIBILI"),
        )
        for share_text, expected_url, expected_platform in cases:
            with self.subTest(share_text=share_text):
                url = extract_douyin_url(share_text)
                self.assertEqual(url, expected_url)
                self.assertEqual(detect_video_platform(url), expected_platform)

    def test_accepts_bilibili_short_link_redirect_to_canonical_host(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def geturl(self):
                return "https://www.bilibili.com/video/BV1ab411c7mD"

        result = probe_douyin_url("https://b23.tv/AbCdEf", opener=lambda *_args, **_kwargs: Response())
        self.assertEqual(result["platform"], "BILIBILI")
        self.assertEqual(result["video_id"], "BV1ab411c7mD")

    def test_rejects_non_douyin_domain(self):
        with self.assertRaises(DouyinResolverError) as context:
            extract_douyin_url("https://example.com/video/1")
        self.assertEqual(context.exception.code, "DOUYIN_DOMAIN_NOT_ALLOWED")

    def test_selects_highest_combined_video_format(self):
        payload = {
            "id": "712345",
            "title": "测试视频",
            "uploader": "测试作者",
            "duration": 12.5,
            "webpage_url": "https://www.douyin.com/video/712345",
            "thumbnail": "https://example.test/cover.jpg",
            "formats": [
                {"format_id": "low", "url": "https://cdn.test/low.mp4", "height": 720, "vcodec": "h264", "acodec": "aac", "ext": "mp4"},
                {"format_id": "high", "url": "https://cdn.test/high.mp4", "height": 1080, "vcodec": "h264", "acodec": "aac", "ext": "mp4"},
                {"format_id": "video-only", "url": "https://cdn.test/video.mp4", "height": 1440, "vcodec": "h264", "acodec": "none", "ext": "mp4"},
            ],
        }

        def runner(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")

        result = resolve_douyin("https://v.douyin.com/AbCdEf/", runner=runner, executable="yt-dlp.exe")
        self.assertEqual(result["download_url"], "https://cdn.test/high.mp4")
        self.assertEqual(result["height"], 1080)
        self.assertEqual(result["title"], "测试视频")
        self.assertEqual(result["platform"], "DOUYIN")

    def test_normalizes_bilibili_platform_metadata(self):
        payload = {
            "id": "BV1ab411c7mD",
            "title": "B站测试视频",
            "url": "https://cdn.test/bilibili.mp4",
            "ext": "mp4",
            "extractor_key": "BiliBili",
        }

        def runner(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")

        result = resolve_douyin("https://www.bilibili.com/video/BV1ab411c7mD", runner=runner, executable="yt-dlp.exe")
        self.assertEqual(result["platform"], "BILIBILI")
        self.assertEqual(result["platform_name"], "哔哩哔哩")

    def test_passes_explicit_browser_cookie_source_to_yt_dlp(self):
        payload = {
            "id": "123",
            "title": "Cookie 测试",
            "url": "https://cdn.test/video.mp4",
            "ext": "mp4",
        }
        captured = {}

        def runner(command, **_kwargs):
            captured["command"] = command
            return subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")

        resolve_douyin(
            "https://www.douyin.com/video/123",
            browser_cookie_source="edge",
            runner=runner,
            executable="yt-dlp.exe",
        )
        command = captured["command"]
        self.assertEqual(command[command.index("--cookies-from-browser") + 1], "edge")

    def test_rejects_unapproved_cookie_browser(self):
        with self.assertRaises(DouyinResolverError) as context:
            resolve_douyin(
                "https://www.douyin.com/video/123",
                browser_cookie_source="unknown-browser",
                executable="yt-dlp.exe",
            )
        self.assertEqual(context.exception.code, "DOUYIN_COOKIE_BROWSER_NOT_ALLOWED")

    def test_explains_when_fresh_cookies_are_required(self):
        def runner(*_args, **_kwargs):
            return subprocess.CompletedProcess(
                [],
                1,
                stdout="",
                stderr="ERROR: [Douyin] 123: Fresh cookies (not necessarily logged in) are needed",
            )

        with self.assertRaises(DouyinResolverError) as context:
            resolve_douyin(
                "https://www.douyin.com/video/123",
                runner=runner,
                executable="yt-dlp.exe",
            )
        self.assertEqual(context.exception.code, "DOUYIN_FRESH_COOKIES_REQUIRED")

    def test_uses_temporary_copy_of_netscape_cookie_file(self):
        payload = {"id": "123", "title": "文件 Cookie", "url": "https://cdn.test/video.mp4", "ext": "mp4"}
        captured = {}

        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "cookies.txt")
            original = "# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t0\ttest\tvalue\n"
            with open(source_path, "w", encoding="utf-8", newline="\n") as cookie_file:
                cookie_file.write(original)

            def runner(command, **_kwargs):
                temporary_path = command[command.index("--cookies") + 1]
                captured["temporary_path"] = temporary_path
                captured["exists_during_run"] = os.path.isfile(temporary_path)
                return subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")

            resolve_douyin(
                "https://www.douyin.com/video/123",
                cookie_file_path=source_path,
                runner=runner,
                executable="yt-dlp.exe",
            )
            with open(source_path, "r", encoding="utf-8") as cookie_file:
                self.assertEqual(cookie_file.read(), original)

        self.assertTrue(captured["exists_during_run"])
        self.assertFalse(os.path.exists(captured["temporary_path"]))

    def test_downloads_video_to_selected_path(self):
        captured = {}
        with tempfile.TemporaryDirectory() as directory:
            output_path = os.path.join(directory, "video.mp4")

            def runner(command, **_kwargs):
                captured["command"] = command
                with open(output_path, "wb") as video_file:
                    video_file.write(b"video-bytes")
                return subprocess.CompletedProcess([], 0, stdout="", stderr="")

            result = download_douyin(
                "https://www.douyin.com/video/123",
                output_path,
                runner=runner,
                executable="yt-dlp.exe",
            )
            self.assertEqual(captured["command"][captured["command"].index("--output") + 1], output_path)
            self.assertEqual(result["saved_path"], output_path)
            self.assertEqual(result["size_bytes"], 11)


if __name__ == "__main__":
    unittest.main()
