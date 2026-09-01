import os
import sys
import tempfile
import unittest
import zipfile

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from workflows.from_script import analyze_script, detect_script_type


SCRIPT = """第一场 外景 雨夜街道
林小凡：今天一定要把最后一单送到。
他冲进雨幕，天空突然闪过一道金光。
周晴：小心！

第二场 内景 出租屋
林小凡看着手中逐渐消失的金光。
林小凡：原来每天只有一个小时。
"""

STRUCTURED_STORYBOARD = """一、项目剧情
标题：街头药瓶风波
主题：误解与救助
基调：紧张、写实
一句话梗概：外卖员与西装男在街头因一辆轿车产生冲突。
故事概要：外卖员准备砸车，西装男匆忙赶来制止并质问，双方在街头对峙。
屏幕比例：9:16
画风设定：写实电影感，自然日光，真实材质，清晰细节

二、全局角色库
【角色 CHAR_001】
名称：外卖员
角色定位：主角
性别与年龄：男性，约35岁
外貌锁定：短发，肤色偏黄，身高175cm，体型偏瘦，面容疲惫
服装锁定：黄灰相间外卖服，深色长裤，黑色运动鞋，黄色头盔
声音锁定：语速偏快

【角色 CHAR_002】
名称：西装男
角色定位：配角
性别与年龄：男性，约40岁
外貌锁定：短发，面容严肃，身高180cm，体型中等
服装锁定：灰色西装，白衬衫，蓝条纹领带，黑色皮鞋
声音锁定：低沉

三、全局场景库
【场景 SCENE_001】
名称：城市街道人行道
场景锁定：城市街道人行道，路边停一辆黑色轿车，背景有商铺、高楼，白天自然光，地面为灰色地砖。

四、分镜列表
第1段（0～10秒）
屏幕比例：9:16
景别：中景
机位：平视
运镜：跟拍
画风设定：写实电影感
场景引用：SCENE_001｜城市街道人行道
场景锁定：城市街道人行道，路边停一辆黑色轿车，背景有商铺、高楼，白天自然光，地面为灰色地砖。
人物引用：CHAR_001｜外卖员；CHAR_002｜西装男
人物锁定：
- CHAR_001｜外卖员｜短发，肤色偏黄，黄灰相间外卖服，深色长裤，黑色运动鞋，黄色头盔
- CHAR_002｜西装男｜短发，面容严肃，灰色西装，白衬衫，蓝条纹领带，黑色皮鞋
画面：外卖员站在黑色轿车旁，西装男从远处跑来。
口播台词：
- 西装男（匆忙焦急）：“别砸！”
动作：外卖员举头盔→西装男跑来喊话
声音：城市环境音，急促脚步声
约束：角色与场景保持一致，无畸形，无字幕。

第2段（10～22秒）
屏幕比例：9:16
景别：近景
机位：侧拍
运镜：缓慢推进
画风设定：写实电影感
场景引用：SCENE_001｜城市街道人行道
场景锁定：城市街道人行道，路边停一辆黑色轿车，背景有商铺、高楼，白天自然光，地面为灰色地砖。
人物引用：CHAR_001｜外卖员；CHAR_002｜西装男
人物锁定：
- CHAR_001｜外卖员｜短发，肤色偏黄，黄灰相间外卖服，深色长裤，黑色运动鞋，黄色头盔
- CHAR_002｜西装男｜短发，面容严肃，灰色西装，白衬衫，蓝条纹领带，黑色皮鞋
画面：外卖员转头看向西装男，头盔停在半空。
口播台词：
- 西装男（厉声质问）：“怎么回事？”
动作：外卖员转头→头盔停在半空
声音：城市环境音
约束：角色与场景保持一致，无畸形，无字幕。
"""


class FromScriptWorkflowTests(unittest.TestCase):
    def test_parses_legacy_segment_format_from_user_example(self):
        script = """第1段（0～10秒）
【屏幕比例】，【机位+运镜】，【画风设定】。
场景锁定：城市街道人行道，路边停一辆黑色轿车，白天自然光，地面为灰色地砖。
人物锁定：
外卖员：男性，约35岁，体型偏瘦，短发，穿黄灰相间外卖服和深色长裤。
西装男：男性，约40岁，短发，穿灰色西装和黑色皮鞋。
小男孩：男性，约8岁，短发，穿蓝色连帽外套，背蓝色书包。
画面：外卖员举起头盔，西装男从远处跑来，小男孩蹲地捡药瓶。
口播台词：
西装男（匆忙焦急感）：“别砸！”
动作：外卖员举头盔→西装男跑来喊话→小男孩捡药瓶。
约束：场景人物服装全部锁定不变。无AI畸形。生成视频不要字幕。
"""
        result = analyze_script({"script_text": script, "creation_spec": {"project_name": "示例"}}, lambda *_: None)
        self.assertEqual(len(result["characters"]), 3)
        self.assertEqual([item["name"] for item in result["characters"]], ["外卖员", "西装男", "小男孩"])
        self.assertEqual(len(result["scenes"]), 1)
        self.assertEqual(len(result["shots"]), 1)
        self.assertEqual(result["shots"][0]["duration"], 10.0)
        self.assertEqual(result["shots"][0]["source_time_range"], {"start": 0.0, "end": 10.0})
        self.assertIn("城市街道人行道", result["shots"][0]["scene_lock"])
        self.assertIn("外卖员", result["shots"][0]["character_lock"])
        self.assertIn("服装全部锁定", result["shots"][0]["constraints"])

    def test_parses_structured_video_storyboard_into_locked_assets_and_shots(self):
        result = analyze_script({
            "script_text": STRUCTURED_STORYBOARD,
            "creation_spec": {"project_name": "街头冲突", "aspect_ratio": "9:16", "target_duration": 22},
        }, lambda *_: None)
        self.assertEqual(result["metadata"]["script_type"], "STRUCTURED_VIDEO_STORYBOARD")
        self.assertEqual(result["story"]["title"], "街头药瓶风波")
        self.assertEqual(result["story"]["theme"], "误解与救助")
        self.assertEqual(result["story"]["tone"], "紧张、写实")
        self.assertIn("外卖员与西装男", result["story"]["logline"])
        self.assertIn("准备砸车", result["story"]["synopsis"])
        self.assertEqual(result["story"]["aspect_ratio"], "9:16")
        self.assertIn("自然日光", result["story"]["visual_style"])
        self.assertEqual(len(result["characters"]), 2)
        self.assertEqual(result["characters"][0]["name"], "外卖员")
        self.assertTrue(result["characters"][0]["locked"])
        self.assertIn("短发", result["characters"][0]["appearance_lock"])
        self.assertIn("外卖服", result["characters"][0]["clothing_lock"])
        self.assertEqual(result["characters"][0]["voice_lock"], "语速偏快")
        self.assertEqual(len(result["scenes"]), 1)
        self.assertTrue(result["scenes"][0]["locked"])
        self.assertEqual(len(result["shots"]), 2)
        self.assertEqual(result["shots"][0]["duration"], 10.0)
        self.assertEqual(result["shots"][1]["duration"], 12.0)
        self.assertEqual(result["shots"][0]["scene_id"], "SCENE_001")
        self.assertEqual(result["shots"][0]["character_ids"], ["CHAR_001", "CHAR_002"])
        self.assertEqual(result["shots"][0]["camera_movement"], "跟拍")
        self.assertEqual(result["shots"][0]["source_time_range"], {"start": 0.0, "end": 10.0})
        self.assertEqual(result["shots"][0]["aspect_ratio"], "9:16")
        self.assertEqual(result["shots"][0]["visual_style"], result["story"]["visual_style"])
        self.assertIn("黑色轿车", result["shots"][0]["scene_lock"])
        self.assertIn("CHAR_001", result["shots"][0]["character_lock"])
        self.assertIn("无字幕", result["shots"][0]["constraints"])
        self.assertIn("匆忙焦急", result["shots"][0]["emotion"])
        self.assertIn("场景锁定", result["shots"][0]["image_prompt"])

    def test_splits_ai_storyboard_segments_that_exceed_fifteen_seconds(self):
        oversized_storyboard = STRUCTURED_STORYBOARD.replace(
            "第2段（10～22秒）",
            "第2段（10～42秒）",
        )
        result = analyze_script({
            "script_text": oversized_storyboard,
            "creation_spec": {"project_name": "超长分镜兜底"},
        }, lambda *_: None)

        shots = result["shots"]
        self.assertEqual([shot["id"] for shot in shots], ["A-001", "A-002", "A-003", "A-004"])
        self.assertTrue(all(shot["duration"] <= 15 for shot in shots))
        self.assertEqual(shots[1]["source_time_range"], {"start": 10.0, "end": 20.0})
        self.assertEqual(shots[-1]["source_time_range"]["end"], 42.0)
        self.assertTrue(all(
            shots[index]["source_time_range"]["end"] == shots[index + 1]["source_time_range"]["start"]
            for index in range(len(shots) - 1)
        ))

    def test_rebases_detailed_visual_timing_for_each_independent_shot(self):
        detailed_storyboard = STRUCTURED_STORYBOARD.replace(
            "画面：外卖员站在黑色轿车旁，西装男从远处跑来。",
            "画面：0～4秒（跟拍）：外卖员站在黑色轿车旁。\n4～10秒（推进）：西装男从远处跑来。",
        ).replace(
            "画面：外卖员转头看向西装男，头盔停在半空。",
            "画面：10～15秒（近景）：外卖员转头看向西装男。\n15～22秒（特写）：头盔停在半空。",
        )
        result = analyze_script({
            "script_text": detailed_storyboard,
            "creation_spec": {"project_name": "局部时间轴"},
        }, lambda *_: None)

        second_shot = result["shots"][1]
        self.assertEqual(second_shot["source_time_range"], {"start": 10.0, "end": 22.0})
        self.assertIn("0～5秒", second_shot["visual"])
        self.assertIn("5～12秒", second_shot["visual"])
        self.assertNotIn("10～15秒", second_shot["visual"])
        self.assertIn("画面：0～5秒", second_shot["video_prompt"])
        self.assertIn("5～12秒", second_shot["image_prompt"])

    def test_keeps_already_local_detailed_visual_timing(self):
        detailed_storyboard = STRUCTURED_STORYBOARD.replace(
            "画面：外卖员转头看向西装男，头盔停在半空。",
            "画面：0～5秒（近景）：外卖员转头看向西装男。\n5～12秒（特写）：头盔停在半空。",
        )
        result = analyze_script({
            "script_text": detailed_storyboard,
            "creation_spec": {"project_name": "局部时间轴"},
        }, lambda *_: None)

        self.assertIn("0～5秒", result["shots"][1]["visual"])
        self.assertIn("5～12秒", result["shots"][1]["visual"])

    def test_pasted_screenplay_builds_canonical_model(self):
        events = []
        result = analyze_script({
            "script_text": SCRIPT,
            "creation_spec": {"project_name": "金光一小时", "target_duration": 60},
        }, lambda *event: events.append(event))
        self.assertEqual(detect_script_type(SCRIPT), "SCREENPLAY")
        self.assertEqual(result["story"]["title"], "金光一小时")
        self.assertGreaterEqual(len(result["characters"]), 2)
        self.assertEqual(len(result["scenes"]), 2)
        self.assertGreaterEqual(len(result["shots"]), 4)
        self.assertIn("appearance_lock", result["characters"][0])
        self.assertIn("source_time_range", result["shots"][0])
        self.assertIn("scene_lock", result["shots"][0])
        self.assertEqual(events[-1][0], 1.0)

    def test_selected_project_style_overrides_understood_video_style(self):
        result = analyze_script({
            "script_text": STRUCTURED_STORYBOARD,
            "creation_spec": {"project_name": "自定义画风", "visual_style": "用户选择的国风水墨预设"},
        }, lambda *_: None)
        self.assertEqual(result["story"]["visual_style"], "用户选择的国风水墨预设")
        self.assertTrue(all(shot["visual_style"] == "用户选择的国风水墨预设" for shot in result["shots"]))

    def test_reads_gb18030_text_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "script.txt")
            with open(path, "wb") as target:
                target.write(SCRIPT.encode("gb18030"))
            result = analyze_script({"script_path": path, "creation_spec": {}}, lambda *_: None)
            self.assertEqual(result["characters"][0]["name"], "林小凡")

    def test_reads_docx_without_external_dependency(self):
        xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>第一场 外景 雨夜街道</w:t></w:r></w:p>
        <w:p><w:r><w:t>林小凡：我要按时送到。</w:t></w:r></w:p>
        </w:body></w:document>"""
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "script.docx")
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", xml.encode("utf-8"))
            result = analyze_script({"script_path": path, "creation_spec": {}}, lambda *_: None)
            self.assertEqual(result["characters"][0]["name"], "林小凡")

    def test_reads_text_pdf(self):
        try:
            import fitz
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "script.pdf")
            document = fitz.open()
            page = document.new_page()
            page.insert_text((72, 72), "SCENE 1 EXT. STREET\nLIN: I will return.")
            document.save(path)
            document.close()
            result = analyze_script({"script_path": path, "creation_spec": {}}, lambda *_: None)
            self.assertGreaterEqual(len(result["shots"]), 1)


if __name__ == "__main__":
    unittest.main()
