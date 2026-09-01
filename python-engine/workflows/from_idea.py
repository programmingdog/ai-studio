import re
import copy
from typing import Any, Callable, Dict, List

ProgressCallback = Callable[[float, str, str], None]

TIME_RANGE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?", re.IGNORECASE)


SHOT_PARAMETERS = {
    "zh-CN": (["远景", "全景", "中景", "近景", "特写"], ["平视", "俯拍", "仰拍", "侧拍", "过肩"], ["固定", "缓慢推进", "跟拍", "横移", "拉远"]),
    "zh-TW": (["遠景", "全景", "中景", "近景", "特寫"], ["平視", "俯拍", "仰拍", "側拍", "過肩"], ["固定", "緩慢推進", "跟拍", "橫移", "拉遠"]),
    "ja": (["ロング", "ワイド", "ミディアム", "クローズアップ", "アップ"], ["アイレベル", "俯瞰", "ローアングル", "サイド", "肩越し"], ["固定", "ゆっくり前進", "追従", "横移動", "引き"]),
    "ko": (["원경", "전경", "중경", "근경", "클로즈업"], ["눈높이", "부감", "로우 앵글", "측면", "오버숄더"], ["고정", "느린 전진", "팔로우", "가로 이동", "줌 아웃"]),
    "fr": (["plan général", "plan large", "plan moyen", "gros plan", "très gros plan"], ["niveau des yeux", "plongée", "contre-plongée", "profil", "par-dessus l’épaule"], ["fixe", "travelling avant lent", "suivi", "travelling latéral", "travelling arrière"]),
    "es": (["gran plano general", "plano general", "plano medio", "primer plano", "plano detalle"], ["nivel de ojos", "picado", "contrapicado", "lateral", "sobre el hombro"], ["fija", "avance lento", "seguimiento", "desplazamiento lateral", "retroceso"]),
    "pt": (["plano geral", "plano aberto", "plano médio", "primeiro plano", "plano detalhe"], ["nível dos olhos", "plongée", "contra-plongée", "lateral", "sobre o ombro"], ["fixa", "avanço lento", "acompanhamento", "movimento lateral", "recuo"]),
    "de": (["Totale", "Weitaufnahme", "Halbnah", "Nahaufnahme", "Detailaufnahme"], ["Augenhöhe", "Aufsicht", "Untersicht", "Seitenansicht", "Schulterperspektive"], ["statisch", "langsame Zufahrt", "Verfolgung", "Seitfahrt", "Rückfahrt"]),
    "bo": (["རྒྱང་རིང་།", "ཡོངས་རྫོགས།", "བར་མ།", "ཉེ་བ།", "ཞིབ་ཆ།"], ["ཐད་ཀར།", "སྟེང་ནས།", "འོག་ནས།", "ཟུར་ནས།", "ཕྲག་པའི་སྟེང་ནས།"], ["གཏན་འཇགས།", "དལ་བུར་མདུན་སྐྱོད།", "རྗེས་འདེད།", "འཕྲེད་སྐྱོད།", "རྒྱབ་སྣུར།"]),
    "ug": (["يىراق كۆرۈنۈش", "ئومۇمىي كۆرۈنۈش", "ئوتتۇرا كۆرۈنۈش", "يېقىن كۆرۈنۈش", "تەپسىلىي كۆرۈنۈش"], ["كۆز ئېگىزلىكى", "ئۈستىدىن", "ئاستىدىن", "يان تەرەپ", "مۈرە ئۈستىدىن"], ["مۇقىم", "ئاستا يېقىنلاش", "ئەگىشىش", "يان يۆتكىلىش", "يىراقلاش"]),
    "mn": (["алсын план", "өргөн план", "дунд план", "ойрын план", "деталь план"], ["нүдний түвшин", "дээрээс", "доороос", "хажуугаас", "мөрний араас"], ["тогтвортой", "удаан ойртох", "дагах", "хажуу тийш шилжих", "холдох"]),
    "en": (["extreme wide", "wide", "medium", "close-up", "extreme close-up"], ["eye level", "high angle", "low angle", "side angle", "over the shoulder"], ["static", "slow push-in", "tracking", "lateral move", "pull-out"]),
}


def _shot_durations(total: float) -> List[float]:
    total = max(5.0, float(total))
    if total <= 15:
        return [round(total, 2)]
    if total < 20:
        return [10.0, round(total - 10.0, 2)]
    count = max(2, int(total // 10))
    duration = total / count
    return [round(duration, 2) for _ in range(count - 1)] + [round(total - round(duration, 2) * (count - 1), 2)]


def _format_seconds(value: float) -> str:
    rounded = round(max(0.0, value), 2)
    return str(int(rounded)) if rounded.is_integer() else str(rounded).rstrip("0").rstrip(".")


def _local_visual(value: Any, duration: float) -> str:
    visual = str(value or "").strip()
    matches = list(TIME_RANGE.finditer(visual))
    if not matches:
        midpoint = round(duration / 2, 2)
        return "0～{0}秒：建立镜头内容与人物状态。\n{0}～{1}秒：{2}".format(_format_seconds(midpoint), _format_seconds(duration), visual or "推进当前分镜动作并完成镜头。")
    first = float(matches[0].group(1))
    last = max(float(match.group(2)) for match in matches)
    span = max(0.001, last - first)
    return TIME_RANGE.sub(lambda match: "{0}～{1}秒".format(
        _format_seconds((float(match.group(1)) - first) / span * duration),
        _format_seconds((float(match.group(2)) - first) / span * duration),
    ), visual)


def _canonical_from_ai(raw: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
    story = copy.deepcopy(raw.get("story") or spec.get("ai_story") or {})
    story["title"] = str(story.get("title") or spec.get("project_name") or "未命名项目")
    story["aspect_ratio"] = str(spec.get("aspect_ratio") or story.get("aspect_ratio") or "9:16")
    story["visual_style"] = str(spec.get("visual_style") or story.get("visual_style") or "电影级统一视觉风格")
    story.setdefault("genre", [str(spec.get("creative_type_name") or "原创剧情")])
    story.setdefault("theme", "")
    story.setdefault("logline", "")
    story.setdefault("synopsis", "")
    story.setdefault("tone", "")

    characters = copy.deepcopy(raw.get("characters") or [])
    for index, character in enumerate(characters, 1):
        character["id"] = "CHAR_{0:03d}".format(index)
        character.setdefault("name", "角色{0}".format(index))
        character.setdefault("role", "配角")
        character.setdefault("gender", "")
        character.setdefault("age_range", "")
        character.setdefault("appearance", {"face": "", "hair": "", "body": "", "clothes": "", "accessories": ""})
        character.setdefault("voice", "")
        character.setdefault("appearance_lock", "")
        character.setdefault("clothing_lock", "")
        character.setdefault("voice_lock", "")
        character.setdefault("story_function", "")
        character["locked"] = bool(character.get("locked", False))
        character.setdefault("reference_assets", [])
        character.pop("personality", None)
        character.pop("motivation", None)

    scenes = copy.deepcopy(raw.get("scenes") or [])
    if not scenes:
        scenes = _scenes()[:1]
    for index, scene in enumerate(scenes, 1):
        scene["id"] = "SCENE_{0:03d}".format(index)
        scene.setdefault("name", "场景{0}".format(index))
        scene.setdefault("location_type", "")
        scene.setdefault("time_of_day", "")
        scene.setdefault("description", "")
        scene.setdefault("lighting", "")
        scene.setdefault("layout", "")
        scene.setdefault("props", [])
        scene.setdefault("mood", "")
        scene["locked"] = bool(scene.get("locked", False))
        scene.setdefault("reference_assets", [])

    raw_shots = copy.deepcopy(raw.get("shots") or [])
    if not raw_shots:
        raise ValueError("AI storyboard did not contain shots")
    durations = _shot_durations(float(spec.get("target_duration") or 60))
    language = str(spec.get("language") or "zh-CN")
    sizes, angles, movements = SHOT_PARAMETERS.get(language, SHOT_PARAMETERS["en"])
    shots: List[Dict[str, Any]] = []
    cursor = 0.0
    for index, duration in enumerate(durations):
        source = copy.deepcopy(raw_shots[min(index, len(raw_shots) - 1)])
        source["id"] = "A-{0:03d}".format(index + 1)
        scene_index = index % len(scenes)
        supplied_scene_id = str(source.get("scene_id") or "")
        if supplied_scene_id.startswith("SCENE_"):
            try:
                scene_index = min(len(scenes) - 1, max(0, int(supplied_scene_id.split("_")[-1]) - 1))
            except ValueError:
                pass
        source["scene_id"] = scenes[scene_index]["id"]
        source["sequence_id"] = "SEQ_{0:03d}".format(scene_index + 1)
        source["character_ids"] = [item for item in source.get("character_ids", []) if any(character["id"] == item for character in characters)] or ([characters[0]["id"]] if characters else [])
        source["duration"] = duration
        source["source_time_range"] = {"start": round(cursor, 2), "end": round(cursor + duration, 2)}
        source["aspect_ratio"] = story["aspect_ratio"]
        source["shot_size"] = sizes[index % len(sizes)]
        source["camera_angle"] = angles[index % len(angles)]
        source["camera_movement"] = movements[index % len(movements)]
        source["visual_style"] = story["visual_style"]
        source["visual"] = _local_visual(source.get("visual") or source.get("action"), duration)
        source.setdefault("action", "")
        source.setdefault("emotion", "")
        source.setdefault("dialogue", "")
        source.setdefault("sound", "")
        source.setdefault("scene_lock", scenes[scene_index].get("description", ""))
        source.setdefault("character_lock", "")
        source.setdefault("constraints", source.get("negative_prompt") or "")
        source.setdefault("negative_prompt", source.get("constraints") or "")
        source["image_prompt"] = "画面：{0}\n项目画风：{1}".format(source["visual"], story["visual_style"])
        source["video_prompt"] = "运镜：{0}\n画面：{1}\n动作：{2}\n台词：{3}\n声音：{4}\n约束：{5}\n项目画风：{6}".format(source["camera_movement"], source["visual"], source["action"], source["dialogue"] or "无", source["sound"] or "无", source["constraints"], story["visual_style"])
        source["status"] = "DRAFT"
        source["locked"] = bool(source.get("locked", False))
        shots.append(source)
        cursor += duration

    sequences = []
    for index, scene in enumerate(scenes, 1):
        scene_shots = [shot for shot in shots if shot["scene_id"] == scene["id"]]
        sequences.append({"id": "SEQ_{0:03d}".format(index), "scene_id": scene["id"], "order": index, "summary": scene.get("description", ""), "character_ids": sorted({character_id for shot in scene_shots for character_id in shot["character_ids"]}), "shot_ids": [shot["id"] for shot in scene_shots]})
    return {"story": story, "characters": characters, "scenes": scenes, "sequences": sequences, "shots": shots}


def _clean_idea(value: Any) -> str:
    idea = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(idea) < 4:
        raise ValueError("idea must contain at least 4 characters")
    if len(idea) > 2000:
        raise ValueError("idea must not exceed 2000 characters")
    return idea


def _characters(idea: str) -> List[Dict[str, Any]]:
    roles = [
        ("林小凡", "PROTAGONIST", "困境中的普通人", "守住善意并掌控突然获得的力量"),
        ("周晴", "ALLY", "敏锐的调查记者", "查清城市异象背后的真相"),
        ("高老板", "ANTAGONIST", "精于算计的利益操盘者", "把异常力量变成自己的筹码"),
        ("老陈", "MENTOR", "看似平凡的修理铺老板", "引导主角理解能力的代价"),
        ("小雨", "EMOTIONAL_ANCHOR", "主角需要守护的妹妹", "让家人过上安稳生活"),
    ]
    characters = []
    for index, (name, role, function, _motivation) in enumerate(roles, 1):
        characters.append({
            "id": "CHAR_{0:03d}".format(index),
            "name": name,
            "role": role,
            "gender": "",
            "age_range": "20-35" if index < 4 else "按剧情设定",
            "appearance": {
                "face": "具有清晰辨识度的东方写实动画面孔",
                "hair": "符合角色职业与性格",
                "body": "自然可信的身形比例",
                "clothes": "都市日常服装，保持跨镜头一致",
                "accessories": "角色专属小件",
            },
            "voice": "自然、有辨识度的普通话",
            "appearance_lock": "具有清晰辨识度的东方写实动画面孔，符合角色职业与性格的发型，自然可信的身形比例",
            "clothing_lock": "都市日常服装，角色专属小件，保持跨镜头一致",
            "voice_lock": "自然、有辨识度的普通话",
            "story_function": function + "；围绕创意“" + idea[:60] + "”推动情节",
            "locked": False,
            "reference_assets": [],
        })
    return characters


def _scenes() -> List[Dict[str, Any]]:
    specs = [
        ("雨夜街道", "EXTERIOR", "NIGHT", "冷色霓虹与雨水反光", "急迫、神秘"),
        ("狭小出租屋", "INTERIOR", "NIGHT", "暖色台灯和窗外城市光", "亲密、压抑"),
        ("老城区修理铺", "INTERIOR", "DAY", "斜射日光与漂浮尘埃", "古旧、隐秘"),
        ("商业中心天台", "EXTERIOR", "SUNSET", "金色逆光和城市天际线", "对峙、壮阔"),
        ("废弃物流仓库", "INTERIOR", "NIGHT", "高窗月光与工业灯", "危险、紧张"),
        ("清晨江边", "EXTERIOR", "DAWN", "柔和晨雾与低饱和天光", "释然、新生"),
    ]
    return [{
        "id": "SCENE_{0:03d}".format(index),
        "name": name,
        "location_type": location_type,
        "time_of_day": time_of_day,
        "description": "都市奇幻故事的" + name + "，空间关系明确并可重复拍摄",
        "lighting": lighting,
        "layout": "建立固定入口、主体区域和背景层次，后续镜头保持方位一致",
        "props": ["剧情线索道具", "生活化陈设"],
        "mood": mood,
        "locked": False,
        "reference_assets": [],
    } for index, (name, location_type, time_of_day, lighting, mood) in enumerate(specs, 1)]


def _shots(
    target_duration: int,
    aspect_ratio: str = "9:16",
    visual_style: str = "电影感动画",
    creative_type_name: str = "",
    creative_type_prompt: str = "",
    language: str = "zh-CN",
) -> List[Dict[str, Any]]:
    beat_actions = [
        "主角在雨中完成最后一单，异常征兆第一次出现",
        "一瞬间的超常反应救下路人",
        "力量消退，主角发现明确的时间限制",
        "回到家中隐瞒身体变化",
        "妹妹无意中说出城市异象的新闻",
        "主角寻找线索来到修理铺",
        "导师指出能力并非没有代价",
        "记者追踪到同一条异常线索",
        "反派通过监控确认主角身份",
        "主角第一次主动测试能力边界",
        "倒计时带来的危险突然逼近",
        "盟友与主角因隐瞒发生冲突",
        "反派以家人为诱饵设下陷阱",
        "众人在仓库正面交锋",
        "力量只剩最后十分钟",
        "主角改变策略，用智慧弥补限制",
        "反派计划被公开并失去控制",
        "主角在代价与守护之间作出选择",
        "清晨众人重新理解彼此",
        "新的异常信号出现，留下结尾钩子",
    ]
    durations = _shot_durations(target_duration)
    sizes, angles, movements = SHOT_PARAMETERS.get(language, SHOT_PARAMETERS["en"])
    shots = []
    timeline_cursor = 0.0
    for index, duration in enumerate(durations, 1):
        action = beat_actions[(index - 1) % len(beat_actions)]
        scene_number = min(6, ((index - 1) // 4) + 1)
        sequence_id = "SEQ_{0:03d}".format(scene_number)
        scene_id = "SCENE_{0:03d}".format(scene_number)
        character_ids = ["CHAR_001"]
        if index in (5, 12, 13, 18, 19):
            character_ids.append("CHAR_005" if index in (5, 13, 18, 19) else "CHAR_002")
        if 8 <= index <= 18:
            character_ids.append("CHAR_002" if "CHAR_002" not in character_ids else "CHAR_003")
        shot_id = "A-{0:03d}".format(index)
        visual = _local_visual(action + "。构图强调角色与环境的空间关系。", duration)
        start_time = round(timeline_cursor, 2)
        constraints = "角色不一致，多余手指，畸形肢体，文字水印，低清晰度"
        shots.append({
            "id": shot_id,
            "sequence_id": sequence_id,
            "scene_id": scene_id,
            "character_ids": character_ids,
            "source_time_range": {"start": start_time, "end": round(start_time + duration, 2)},
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "shot_size": sizes[(index - 1) % len(sizes)],
            "camera_angle": angles[(index - 1) % len(angles)],
            "camera_movement": movements[(index - 1) % len(movements)],
            "visual_style": visual_style,
            "scene_lock": "保持场景空间、光线、陈设和方位关系一致",
            "character_lock": "；".join(character_ids) + " 的外貌、服装和声音保持一致",
            "visual": visual,
            "action": action,
            "emotion": "随剧情推进由疑惑转为坚定",
            "dialogue": "" if index % 3 else "我必须在时间结束前做出选择。",
            "sound": "城市环境音与克制的电影配乐",
            "image_prompt": "{0}，屏幕比例 {1}，{2}".format(visual_style, aspect_ratio, visual),
            "video_prompt": "运镜：{0}\n画面：{1}\n动作：{2}\n台词：{3}\n声音：城市环境音与克制的电影配乐\n约束：{4}\n项目画风：{5}".format(movements[(index - 1) % len(movements)], visual, action, "无" if index % 3 else "我必须在时间结束前做出选择。", constraints, visual_style),
            "negative_prompt": constraints,
            "constraints": constraints,
            "status": "DRAFT",
            "locked": False,
        })
        timeline_cursor += duration
    return shots


def develop_idea(params: Dict[str, Any], report: ProgressCallback) -> Dict[str, Any]:
    idea = _clean_idea(params.get("idea"))
    spec = params.get("creation_spec") or {}
    target_duration = int(spec.get("target_duration", 60))
    target_duration = max(15, min(target_duration, 600))
    creative_type_name = str(spec.get("creative_type_name") or "原创剧情").strip()
    creative_type_category = str(spec.get("creative_type_category") or "").strip()
    creative_type_prompt = str(spec.get("creative_type_prompt") or "").strip()

    if isinstance(spec.get("ai_canonical"), dict):
        report(0.08, "story_received", "已收到大模型生成的整体剧情")
        report(0.45, "storyboard_normalization", "正在校验分镜时长、局部时间轴和语言")
        canonical = _canonical_from_ai(spec["ai_canonical"], spec)
        report(1.0, "completed", "创意开发完成")
        return canonical

    report(0.08, "concept_expansion", "正在扩展创意概念")
    story = {
        "title": str(spec.get("project_name") or "限时英雄"),
        "logline": idea + "，但每一次选择都让他更接近必须承担的代价。",
        "genre": [value for value in (creative_type_name, creative_type_category) if value],
        "theme": "能力的价值取决于如何使用它",
        "synopsis": "以“{0}”类型开发创意“{1}”，围绕人物目标、核心冲突与选择代价逐步展开。".format(creative_type_name, idea),
        "tone": "遵循{0}的经典叙事气质与节奏".format(creative_type_name),
        "aspect_ratio": str(spec.get("aspect_ratio") or "9:16"),
        "visual_style": str(spec.get("visual_style") or "电影感动画"),
    }

    report(0.30, "character_design", "正在建立角色设定")
    characters = _characters(idea)
    report(0.50, "scene_design", "正在建立场景设定")
    scenes = _scenes()
    report(0.68, "storyboard", "正在规划分镜")
    shots = _shots(
        target_duration,
        str(spec.get("aspect_ratio") or "9:16"),
        str(spec.get("visual_style") or "电影感动画"),
        creative_type_name,
        creative_type_prompt,
        str(spec.get("language") or "zh-CN"),
    )

    sequences = []
    for index, scene in enumerate(scenes, 1):
        sequence_shots = [shot["id"] for shot in shots if shot["scene_id"] == scene["id"]]
        character_ids = sorted({
            character_id
            for shot in shots if shot["scene_id"] == scene["id"]
            for character_id in shot["character_ids"]
        })
        sequences.append({
            "id": "SEQ_{0:03d}".format(index),
            "scene_id": scene["id"],
            "order": index,
            "summary": "在{0}推进第 {1} 段剧情".format(scene["name"], index),
            "character_ids": character_ids,
            "shot_ids": sequence_shots,
        })

    report(0.92, "canonical_validation", "正在校验 Canonical Model")
    canonical = {
        "story": story,
        "characters": characters,
        "scenes": scenes,
        "sequences": sequences,
        "shots": shots,
    }
    report(1.0, "completed", "创意开发完成")
    return canonical
