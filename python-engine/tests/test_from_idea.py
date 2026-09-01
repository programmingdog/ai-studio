import os
import sys
import unittest

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from workflows.from_idea import develop_idea


class FromIdeaWorkflowTests(unittest.TestCase):
    def test_builds_complete_canonical_project(self):
        events = []
        result = develop_idea({
            "idea": "一个外卖员获得孙悟空能力，每天只能变身一个小时。",
            "creation_spec": {"project_name": "齐天一小时", "target_duration": 60},
        }, lambda *event: events.append(event))

        self.assertEqual(result["story"]["title"], "齐天一小时")
        self.assertEqual(len(result["characters"]), 5)
        self.assertEqual(len(result["scenes"]), 6)
        self.assertEqual(len(result["shots"]), 6)
        self.assertEqual(len(result["sequences"]), 6)
        self.assertEqual(events[-1][0], 1.0)

        character_ids = {character["id"] for character in result["characters"]}
        scene_ids = {scene["id"] for scene in result["scenes"]}
        for shot in result["shots"]:
            self.assertIn(shot["scene_id"], scene_ids)
            self.assertTrue(set(shot["character_ids"]).issubset(character_ids))
            self.assertGreaterEqual(shot["duration"], 10)
            self.assertLessEqual(shot["duration"], 15)
            self.assertTrue(shot["visual"].startswith("0～"))

    def test_rejects_blank_idea(self):
        with self.assertRaises(ValueError):
            develop_idea({"idea": "  "}, lambda *_: None)

    def test_applies_selected_creative_type_to_story_and_generation_prompts(self):
        result = develop_idea({
            "idea": "失忆将军在最后一场大战前找回身份。",
            "creation_spec": {
                "project_name": "归阵",
                "creative_type_category": "电影",
                "creative_type_name": "战争史诗",
                "creative_type_prompt": "突出阵营目标、战略冲突与战争代价。",
            },
        }, lambda *_: None)

        self.assertEqual(result["story"]["genre"], ["战争史诗", "电影"])
        self.assertIn("战争史诗", result["story"]["synopsis"])
        self.assertNotIn("战略冲突", result["shots"][0]["video_prompt"])
        self.assertNotIn("战争史诗", result["shots"][0]["visual"])

    def test_normalizes_ai_storyboard_duration_local_timeline_and_chinese_parameters(self):
        ai_canonical = {
            "story": {"title": "归阵", "logline": "将军归来", "genre": ["战争史诗"], "theme": "牺牲", "synopsis": "完整剧情", "tone": "壮阔"},
            "characters": [{"name": "将军", "appearance": {"face": "坚毅", "hair": "束发", "body": "高大", "clothes": "战甲", "accessories": "长剑"}}],
            "scenes": [{"name": "古战场", "description": "旌旗与尘烟覆盖的古战场"}],
            "shots": [
                {"scene_id": "SCENE_001", "character_ids": ["CHAR_001"], "visual": "0～5秒：将军登场。\n5～12秒：军阵推进。", "action": "将军率军推进"},
                {"scene_id": "SCENE_001", "character_ids": ["CHAR_001"], "visual": "12～18秒：双方交锋。\n18～25秒：将军举剑。", "action": "双方决战"},
            ],
        }
        result = develop_idea({
            "idea": "失忆将军重返战场。",
            "creation_spec": {
                "project_name": "归阵",
                "target_duration": 25,
                "language": "zh-CN",
                "visual_style": "历史电影写实",
                "creative_type_name": "战争史诗",
                "creative_type_prompt": "这段文字只能用于整体剧情",
                "ai_canonical": ai_canonical,
            },
        }, lambda *_: None)

        self.assertEqual([shot["duration"] for shot in result["shots"]], [12.5, 12.5])
        self.assertTrue(all(shot["visual"].startswith("0～") for shot in result["shots"]))
        self.assertEqual(result["shots"][0]["shot_size"], "远景")
        self.assertEqual(result["shots"][0]["camera_angle"], "平视")
        self.assertEqual(result["shots"][0]["camera_movement"], "固定")
        self.assertNotIn("创作类型", result["shots"][0]["image_prompt"])
        self.assertNotIn("这段文字", result["shots"][0]["video_prompt"])


if __name__ == "__main__":
    unittest.main()
