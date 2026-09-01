import json
import os
import subprocess
import sys
import unittest

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ProtocolTests(unittest.TestCase):
    def run_worker(self, request):
        completed = subprocess.run(
            [sys.executable, "main.py"],
            cwd=ENGINE_ROOT,
            input=json.dumps(request, ensure_ascii=False) + "\n",
            encoding="utf-8",
            capture_output=True,
            check=True,
        )
        return [json.loads(line) for line in completed.stdout.splitlines()]

    def test_ping_round_trip(self):
        request = {"version": "1.0", "id": "req_test", "type": "request", "method": "system.ping", "params": {}}
        messages = self.run_worker(request)
        self.assertEqual(messages[-1]["type"], "result")
        self.assertEqual(messages[-1]["data"]["status"], "ok")

    def test_chinese_idea_is_utf8_end_to_end(self):
        request = {
            "version": "1.0",
            "id": "req_chinese",
            "type": "request",
            "method": "workflow.develop_idea",
            "params": {
                "idea": "一个外卖员获得孙悟空能力，每天只能变身一个小时。",
                "creation_spec": {"project_name": "齐天一小时", "target_duration": 60},
            },
        }
        messages = self.run_worker(request)
        self.assertTrue(any(message.get("message", "").startswith("正在") for message in messages))
        self.assertEqual(messages[-1]["data"]["story"]["title"], "齐天一小时")


if __name__ == "__main__":
    unittest.main()
