import re
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from inputs.script_input import read_script

ProgressCallback = Callable[[float, str, str], None]
SCENE_HEADING = re.compile(
    r"^(?:第\s*[一二三四五六七八九十百0-9]+\s*场|场景\s*[一二三四五六七八九十百0-9]+|(?:INT|EXT|内景|外景)[.．\s])",
    re.IGNORECASE,
)
DIALOGUE = re.compile(r"^([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·_ ]{0,15})[：:]\s*(.+)$")
STORYBOARD_SEGMENT = re.compile(
    r"(?m)^\s*(?:\*\*)?第\s*(\d+)\s*段\s*[（(]\s*(\d+(?:\.\d+)?)\s*(?:～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒?\s*[）)](?:\*\*)?\s*$"
)
STRUCTURED_FIELDS = {
    "屏幕比例", "景别", "机位", "运镜", "画风设定", "场景引用", "场景锁定",
    "人物引用", "人物锁定", "画面", "口播台词", "动作", "声音", "约束",
}


def detect_script_type(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    scene_count = sum(1 for line in lines if SCENE_HEADING.match(line))
    dialogue_count = sum(1 for line in lines if DIALOGUE.match(line))
    shot_count = sum(1 for line in lines if re.match(r"^(?:镜头|SHOT|第\s*\d+\s*段|\d+[.-])", line, re.IGNORECASE))
    if scene_count >= 1:
        return "SCREENPLAY"
    if shot_count >= 3:
        return "SHOT_SCRIPT"
    if dialogue_count >= 3:
        return "DIALOGUE_SCRIPT"
    if sum(1 for line in lines if re.match(r"^\d+[.、]", line)) >= 3:
        return "STORY_OUTLINE"
    if len(text) >= 500:
        return "NOVEL"
    return "UNKNOWN"


def _extract_characters(lines: Sequence[str]) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    names: List[str] = []
    for line in lines:
        match = DIALOGUE.match(line)
        if match and match.group(1).strip() not in names:
            names.append(match.group(1).strip())
    if not names:
        names = ["主角"]
    names = names[:12]
    characters = []
    mapping = {}
    for index, name in enumerate(names, 1):
        character_id = "CHAR_{0:03d}".format(index)
        mapping[name] = character_id
        characters.append({
            "id": character_id,
            "name": name,
            "role": "PROTAGONIST" if index == 1 else "SUPPORTING",
            "gender": "",
            "age_range": "",
            "appearance": {"face": "待设定", "hair": "待设定", "body": "待设定", "clothes": "待设定", "accessories": ""},
            "voice": "待设定",
            "appearance_lock": "待根据剧本设定",
            "clothing_lock": "待根据剧本设定",
            "voice_lock": "待设定",
            "story_function": "来自原始剧本的出场角色",
            "locked": False,
            "reference_assets": [],
        })
    return characters, mapping


def _scene_blocks(lines: Sequence[str]) -> List[Tuple[str, List[str]]]:
    blocks: List[Tuple[str, List[str]]] = []
    current_name = "场景 1"
    current_lines: List[str] = []
    for line in lines:
        if SCENE_HEADING.match(line):
            if current_lines:
                blocks.append((current_name, current_lines))
            current_name = line[:80]
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines:
        blocks.append((current_name, current_lines))
    if not blocks:
        blocks = [("场景 1", list(lines))]
    return blocks[:30]


def _beats(lines: Sequence[str]) -> List[Dict[str, str]]:
    types = ["HOOK", "SETUP", "INCITING_INCIDENT", "CONFLICT", "ESCALATION", "REVERSAL", "CLIMAX", "RESOLUTION", "ENDING_HOOK"]
    meaningful = [line for line in lines if len(line) >= 4] or ["剧本内容"]
    result = []
    for index, beat_type in enumerate(types):
        source_index = min(len(meaningful) - 1, round(index * (len(meaningful) - 1) / max(1, len(types) - 1)))
        result.append({"id": "BEAT_{0:03d}".format(index + 1), "type": beat_type, "description": meaningful[source_index][:180]})
    return result


def _clean_markup(value: str) -> str:
    return str(value or "").strip().strip("*").strip()


def _parse_labeled_fields(text: str, allowed: Sequence[str]) -> Dict[str, str]:
    allowed_set = set(allowed)
    fields: Dict[str, List[str]] = {}
    current = ""
    for raw_line in text.splitlines():
        line = _clean_markup(raw_line)
        match = re.match(r"^([^：:]{1,20})[：:]\s*(.*)$", line)
        label = _clean_markup(match.group(1)) if match else ""
        if label in allowed_set:
            current = label
            fields.setdefault(current, [])
            if match and match.group(2).strip():
                fields[current].append(match.group(2).strip())
        elif current and line:
            fields[current].append(line)
    return {key: "\n".join(value).strip() for key, value in fields.items()}


def _section(text: str, start_pattern: str, end_pattern: str) -> str:
    match = re.search(start_pattern + r"(.*?)" + end_pattern, text, re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else ""


def _asset_blocks(text: str, kind: str) -> List[Tuple[str, str]]:
    pattern = re.compile(
        r"【\s*{0}\s+([A-Za-z]+_[A-Za-z0-9_]+)\s*】(.*?)(?=【\s*{0}\s+[A-Za-z]+_[A-Za-z0-9_]+\s*】|\Z)".format(kind),
        re.DOTALL | re.IGNORECASE,
    )
    return [(match.group(1).upper(), match.group(2).strip()) for match in pattern.finditer(text)]


def _split_reference(value: str) -> Tuple[str, str]:
    parts = [_clean_markup(part) for part in re.split(r"[｜|]", value) if _clean_markup(part)]
    return (parts[0], parts[1] if len(parts) > 1 else "") if parts else ("", "")


def _character_from_lock(
    character_id: str,
    name: str,
    detail: str,
    role: str = "SUPPORTING",
    voice: str = "未识别",
    appearance_lock: str = "",
    clothing_lock: str = "",
) -> Dict[str, Any]:
    appearance_lock = appearance_lock or detail or "待设定"
    clothing_lock = clothing_lock or "；".join(
        sentence for sentence in re.split(r"[。；;]", detail)
        if any(word in sentence for word in ("穿", "服", "鞋", "帽", "配饰"))
    ) or "见外貌锁定"
    age_match = re.search(r"(?:约\s*)?(\d{1,3})\s*岁", detail)
    return {
        "id": character_id,
        "name": name or character_id,
        "role": role or "SUPPORTING",
        "gender": "FEMALE" if "女性" in detail or "女，" in detail else "MALE" if "男性" in detail or "男，" in detail else "",
        "age_range": age_match.group(1) if age_match else "",
        "appearance": {
            "face": detail or "待设定",
            "hair": next((sentence for sentence in re.split(r"[。；;]", detail) if "发" in sentence), "见外貌锁定"),
            "body": next((sentence for sentence in re.split(r"[。；;]", detail) if any(word in sentence for word in ("身高", "体型", "身材"))), "见外貌锁定"),
            "clothes": clothing_lock,
            "accessories": "见服装锁定",
        },
        "voice": voice or "未识别",
        "appearance_lock": appearance_lock,
        "clothing_lock": clothing_lock,
        "voice_lock": voice or "未识别",
        "story_function": "视频中识别的角色",
        "locked": True,
        "reference_assets": [],
    }


def _parse_person_locks(value: str) -> List[Tuple[str, str, str]]:
    result: List[Tuple[str, str, str]] = []
    for raw_line in value.splitlines():
        line = re.sub(r"^[-•]\s*", "", _clean_markup(raw_line))
        if not line or line == "无":
            continue
        parts = [_clean_markup(part) for part in re.split(r"[｜|]", line)]
        if len(parts) >= 3 and re.match(r"^CHAR_[A-Z0-9_]+$", parts[0], re.IGNORECASE):
            result.append((parts[0].upper(), parts[1], "｜".join(parts[2:])))
            continue
        match = re.match(r"^([^：:]{1,30})[：:]\s*(.+)$", line)
        if match:
            result.append(("", match.group(1).strip(), match.group(2).strip()))
    return result


def _bounded_shot_ranges(start_time: float, end_time: float) -> List[Tuple[float, float]]:
    """Split an AI-produced source range so no project shot exceeds 15 seconds."""
    start_time = round(start_time, 3)
    end_time = round(max(start_time + 0.5, end_time), 3)
    if end_time - start_time <= 15:
        return [(start_time, end_time)]

    ranges: List[Tuple[float, float]] = []
    cursor = start_time
    while end_time - cursor > 15:
        remaining = end_time - cursor
        # When the tail can form two normal 10–15 second shots, distribute it
        # evenly instead of leaving a very short remainder.
        if 20 < remaining < 30:
            midpoint = round(cursor + remaining / 2, 3)
            ranges.extend(((cursor, midpoint), (midpoint, end_time)))
            return ranges
        next_time = round(cursor + 10, 3)
        ranges.append((cursor, next_time))
        cursor = next_time
    ranges.append((cursor, end_time))
    return ranges


VISUAL_TIME_RANGE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒"
)


def _format_timeline_seconds(value: float) -> str:
    rounded = round(max(0.0, value), 3)
    return str(int(rounded)) if rounded.is_integer() else ("{0:.3f}".format(rounded).rstrip("0").rstrip("."))


def _localize_visual_timeline(
    visual: str,
    source_start: float,
    source_end: float,
    bounded_start: float,
    bounded_end: float,
) -> str:
    """Rebase detailed visual timing to the current independently generated shot.

    The segment heading/source_time_range remains on the original video timeline.
    Timings embedded in the visual field are local to the generated shot and must
    therefore always start from zero. This also clips visual beats when a model
    produced a source segment longer than the supported 15-second shot limit.
    """
    matches = list(VISUAL_TIME_RANGE.finditer(visual))
    if not matches:
        return visual

    epsilon = 0.001
    uses_global_timeline = source_start > epsilon and all(
        float(match.group(1)) >= source_start - epsilon for match in matches
    )
    localized_lines: List[str] = []
    for line in visual.splitlines():
        line_matches = list(VISUAL_TIME_RANGE.finditer(line))
        if not line_matches:
            localized_lines.append(line)
            continue

        replacements: List[Tuple[int, int, str]] = []
        for match in line_matches:
            raw_start = float(match.group(1))
            raw_end = float(match.group(3))
            absolute_start = raw_start if uses_global_timeline else source_start + raw_start
            absolute_end = raw_end if uses_global_timeline else source_start + raw_end
            overlap_start = max(absolute_start, bounded_start)
            overlap_end = min(absolute_end, bounded_end)
            if overlap_end <= overlap_start + epsilon:
                continue
            replacement = "{0}{1}{2}秒".format(
                _format_timeline_seconds(overlap_start - bounded_start),
                match.group(2),
                _format_timeline_seconds(overlap_end - bounded_start),
            )
            replacements.append((match.start(), match.end(), replacement))

        # A timed beat outside the bounded child shot does not belong in its prompt.
        if not replacements:
            continue
        localized_line = line
        for start, end, replacement in reversed(replacements):
            localized_line = localized_line[:start] + replacement + localized_line[end:]
        localized_lines.append(localized_line)

    localized = "\n".join(localized_lines).strip()
    return localized or visual


def _structured_storyboard(text: str, spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    matches = list(STORYBOARD_SEGMENT.finditer(text))
    if not matches:
        return None

    project_section = _section(text, r"(?:[一二三四]、?\s*)?项目剧情", r"(?=(?:[一二三四]、?\s*)?全局角色库|【角色)")
    project_fields = _parse_labeled_fields(project_section, ("标题", "主题", "基调", "一句话梗概", "故事概要", "屏幕比例", "画风设定"))
    character_section = _section(text, r"(?:[一二三四]、?\s*)?全局角色库", r"(?=(?:[一二三四]、?\s*)?全局场景库|(?:[一二三四]、?\s*)?分镜列表|第\s*1\s*段)")
    scene_section = _section(text, r"(?:[一二三四]、?\s*)?全局场景库", r"(?=(?:[一二三四]、?\s*)?分镜列表|第\s*1\s*段)")
    characters_by_id: Dict[str, Dict[str, Any]] = {}
    character_id_by_name: Dict[str, str] = {}
    for character_id, body in _asset_blocks(character_section, "角色"):
        fields = _parse_labeled_fields(body, ("名称", "角色定位", "性别与年龄", "外貌锁定", "服装锁定", "声音锁定"))
        name = fields.get("名称") or character_id
        appearance_lock = fields.get("外貌锁定") or ""
        clothing_lock = fields.get("服装锁定") or ""
        detail = "。".join(filter(None, (fields.get("性别与年龄"), appearance_lock, clothing_lock)))
        character = _character_from_lock(
            character_id,
            name,
            detail,
            fields.get("角色定位") or "SUPPORTING",
            fields.get("声音锁定") or "未识别",
            appearance_lock,
            clothing_lock,
        )
        characters_by_id[character_id] = character
        character_id_by_name[name] = character_id

    scenes_by_id: Dict[str, Dict[str, Any]] = {}
    scene_id_by_lock: Dict[str, str] = {}
    for scene_id, body in _asset_blocks(scene_section, "场景"):
        fields = _parse_labeled_fields(body, ("名称", "场景锁定"))
        name = fields.get("名称") or scene_id
        lock = fields.get("场景锁定") or name
        scenes_by_id[scene_id] = _scene_entity(scene_id, name, lock)
        scene_id_by_lock[lock] = scene_id

    parsed_blocks = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        fields = _parse_labeled_fields(text[match.end():end], tuple(STRUCTURED_FIELDS))
        if fields:
            parsed_blocks.append((match, fields))
    if not parsed_blocks:
        return None

    first_shot_fields = parsed_blocks[0][1]
    project_aspect_ratio = project_fields.get("屏幕比例") or first_shot_fields.get("屏幕比例") or str(spec.get("aspect_ratio") or "9:16")
    project_aspect_ratio = "16:9" if "16:9" in project_aspect_ratio else "9:16"
    project_visual_style = str(spec.get("visual_style") or "") or project_fields.get("画风设定") or first_shot_fields.get("画风设定") or "写实电影感"

    shots: List[Dict[str, Any]] = []
    for match, fields in parsed_blocks:
        start_time = float(match.group(2))
        end_time = float(match.group(3))
        scene_ref_id, scene_ref_name = _split_reference(fields.get("场景引用", ""))
        if not re.match(r"^SCENE_[A-Z0-9_]+$", scene_ref_id, re.IGNORECASE):
            scene_ref_id = ""
        scene_ref_id = scene_ref_id.upper()
        scene_lock = fields.get("场景锁定") or scene_ref_name or "未识别场景"
        if not scene_ref_id:
            scene_ref_id = scene_id_by_lock.get(scene_lock, "")
        if not scene_ref_id:
            scene_ref_id = "SCENE_{0:03d}".format(len(scenes_by_id) + 1)
        if scene_ref_id not in scenes_by_id:
            scenes_by_id[scene_ref_id] = _scene_entity(scene_ref_id, scene_ref_name or "场景 {0}".format(len(scenes_by_id) + 1), scene_lock)
        scene_id_by_lock[scene_lock] = scene_ref_id

        locked_people = _parse_person_locks(fields.get("人物锁定", ""))
        referenced_people = [item.strip() for item in re.split(r"[；;]", fields.get("人物引用", "")) if item.strip() and item.strip() != "无"]
        for reference in referenced_people:
            ref_id, ref_name = _split_reference(reference)
            if ref_id and ref_name and ref_name not in character_id_by_name:
                character_id_by_name[ref_name] = ref_id.upper()
        character_ids: List[str] = []
        for supplied_id, name, detail in locked_people:
            character_id = supplied_id or character_id_by_name.get(name, "")
            if not character_id:
                character_id = "CHAR_{0:03d}".format(len(characters_by_id) + 1)
            if character_id not in characters_by_id:
                characters_by_id[character_id] = _character_from_lock(character_id, name, detail)
            character_id_by_name[name] = character_id
            if character_id not in character_ids:
                character_ids.append(character_id)
        for reference in referenced_people:
            ref_id, ref_name = _split_reference(reference)
            character_id = (ref_id.upper() if re.match(r"^CHAR_[A-Z0-9_]+$", ref_id, re.IGNORECASE) else character_id_by_name.get(ref_name or ref_id, ""))
            if character_id and character_id not in character_ids:
                character_ids.append(character_id)

        dialogue_lines = [re.sub(r"^[-•]\s*", "", line).strip() for line in fields.get("口播台词", "").splitlines()]
        dialogue = "\n".join(line for line in dialogue_lines if line and line != "无")
        person_lock_text = fields.get("人物锁定") or "无"
        constraint = fields.get("约束") or "角色、场景和服装保持一致；无畸形；无文字水印；不要字幕"
        visual = fields.get("画面") or fields.get("动作") or "待补充分镜画面"
        action = fields.get("动作") or visual
        shot_base = {
            "sequence_id": "",
            "scene_id": scene_ref_id,
            "character_ids": character_ids,
            "aspect_ratio": project_aspect_ratio,
            "shot_size": fields.get("景别") or "MEDIUM",
            "camera_angle": fields.get("机位") or "EYE_LEVEL",
            "camera_movement": fields.get("运镜") or "STATIC",
            "visual_style": project_visual_style,
            "scene_lock": scene_lock,
            "character_lock": person_lock_text,
            "visual": visual,
            "action": action,
            "emotion": _dialogue_emotion(dialogue),
            "dialogue": dialogue,
            "sound": fields.get("声音") or "未识别",
            "image_prompt": "；".join(filter(None, (
                "屏幕比例：" + project_aspect_ratio,
                "景别：" + (fields.get("景别") or "中景"),
                "机位与运镜：" + "，".join(filter(None, (fields.get("机位"), fields.get("运镜")))),
                "画风：" + project_visual_style,
                "场景锁定：" + scene_lock,
                "人物锁定：" + person_lock_text,
                "画面：" + visual,
            ))),
            "video_prompt": "；".join(filter(None, (
                "运镜：" + (fields.get("运镜") or "固定"),
                "画面：" + visual,
                "动作：" + action,
                "台词：" + (dialogue or "无"),
                "声音：" + (fields.get("声音") or "未识别"),
                "约束：" + constraint,
            ))),
            "negative_prompt": constraint,
            "constraints": constraint,
            "status": "DRAFT",
            "locked": False,
        }
        for bounded_start, bounded_end in _bounded_shot_ranges(start_time, end_time):
            localized_visual = _localize_visual_timeline(
                visual, start_time, end_time, bounded_start, bounded_end
            )
            localized_action = _localize_visual_timeline(
                action, start_time, end_time, bounded_start, bounded_end
            )
            shot = dict(shot_base)
            shot["visual"] = localized_visual
            shot["action"] = localized_action
            shot["image_prompt"] = shot["image_prompt"].replace(
                "画面：" + visual, "画面：" + localized_visual
            )
            shot["video_prompt"] = shot["video_prompt"].replace(
                "画面：" + visual, "画面：" + localized_visual
            )
            shot["video_prompt"] = shot["video_prompt"].replace(
                "动作：" + action, "动作：" + localized_action
            )
            shot.update({
                "id": "A-{0:03d}".format(len(shots) + 1),
                "source_time_range": {"start": bounded_start, "end": bounded_end},
                "duration": round(bounded_end - bounded_start, 2),
            })
            shots.append(shot)

    scenes = list(scenes_by_id.values())
    characters = list(characters_by_id.values())
    if not characters:
        characters = [_character_from_lock("CHAR_001", "主角", "待根据视频确认")]
    sequences = []
    for index, scene in enumerate(scenes, 1):
        sequence_id = "SEQ_{0:03d}".format(index)
        scene_shots = [shot for shot in shots if shot["scene_id"] == scene["id"]]
        for shot in scene_shots:
            shot["sequence_id"] = sequence_id
        sequences.append({
            "id": sequence_id,
            "scene_id": scene["id"],
            "order": index,
            "summary": scene["description"],
            "character_ids": sorted({character_id for shot in scene_shots for character_id in shot["character_ids"]}),
            "shot_ids": [shot["id"] for shot in scene_shots],
        })
    title = project_fields.get("标题") or str(spec.get("project_name") or "视频分镜项目")
    beat_lines = [shot["visual"] for shot in shots]
    return {
        "story": {
            "title": title,
            "logline": project_fields.get("一句话梗概") or (beat_lines[0][:240] if beat_lines else title),
            "genre": ["STRUCTURED_VIDEO_STORYBOARD"],
            "theme": project_fields.get("主题") or "根据视频内容继续完善",
            "synopsis": project_fields.get("故事概要") or "\n".join(beat_lines[:8])[:1000],
            "tone": project_fields.get("基调") or "依据原视频",
            "aspect_ratio": project_aspect_ratio,
            "visual_style": project_visual_style,
        },
        "characters": characters,
        "scenes": scenes,
        "sequences": sequences,
        "shots": shots,
        "metadata": {"script_type": "STRUCTURED_VIDEO_STORYBOARD", "source_character_count": len(text)},
    }


def _scene_entity(scene_id: str, name: str, lock: str) -> Dict[str, Any]:
    return {
        "id": scene_id,
        "name": name,
        "location_type": "INTERIOR" if any(word in lock for word in ("室内", "房间", "店内", "车内")) else "EXTERIOR" if any(word in lock for word in ("室外", "街道", "户外", "广场")) else "UNSPECIFIED",
        "time_of_day": "NIGHT" if any(word in lock for word in ("夜", "黑夜", "夜晚")) else "DAY" if any(word in lock for word in ("白天", "日间", "阳光")) else "UNSPECIFIED",
        "description": lock,
        "lighting": next((sentence for sentence in re.split(r"[。；;]", lock) if any(word in sentence for word in ("光", "照明", "明亮", "昏暗"))), "见场景锁定"),
        "layout": lock,
        "props": [],
        "mood": "依据原视频",
        "locked": True,
        "reference_assets": [],
    }


def _dialogue_emotion(dialogue: str) -> str:
    emotions = re.findall(r"[（(]([^）)]+)[）)]", dialogue)
    return "、".join(dict.fromkeys(emotions)) if emotions else "根据画面与台词判断"


def analyze_script(params: Dict[str, Any], report: ProgressCallback) -> Dict[str, Any]:
    report(0.05, "script_read", "正在读取剧本")
    text = read_script(params)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    script_type = detect_script_type(text)
    report(0.20, "structure_detection", "识别为 {0}".format(script_type))

    structured = _structured_storyboard(text, params.get("creation_spec") or {})
    if structured:
        report(0.38, "character_extraction", "已提取 {0} 个锁定角色".format(len(structured["characters"])))
        report(0.54, "scene_extraction", "已提取 {0} 个锁定场景".format(len(structured["scenes"])))
        report(0.78, "shot_planning", "已解析 {0} 个结构化分镜".format(len(structured["shots"])))
        report(1.0, "completed", "结构化视频分镜分析完成")
        return structured

    characters, character_mapping = _extract_characters(lines)
    report(0.38, "character_extraction", "已提取 {0} 个角色".format(len(characters)))
    blocks = _scene_blocks(lines)
    scenes = []
    for index, (name, content) in enumerate(blocks, 1):
        heading = name.upper()
        scenes.append({
            "id": "SCENE_{0:03d}".format(index),
            "name": name,
            "location_type": "INTERIOR" if "INT" in heading or "内景" in name else "EXTERIOR" if "EXT" in heading or "外景" in name else "UNSPECIFIED",
            "time_of_day": "NIGHT" if "夜" in name else "DAY" if "日" in name or "昼" in name else "UNSPECIFIED",
            "description": " ".join(content[:3])[:300] or name,
            "lighting": "待根据剧情设定",
            "layout": "待建立场景空间结构",
            "props": [],
            "mood": "根据本场冲突设定",
            "locked": False,
            "reference_assets": [],
        })
    report(0.54, "scene_extraction", "已提取 {0} 个场景".format(len(scenes)))

    target_duration = max(15, min(int((params.get("creation_spec") or {}).get("target_duration", 60)), 3600))
    shot_sources: List[Tuple[int, str]] = []
    for scene_index, (_, content) in enumerate(blocks):
        for line in content:
            if len(line) >= 2:
                shot_sources.append((scene_index, line))
    shot_sources = shot_sources[:80] or [(0, "根据剧本建立开场镜头")]
    duration = round(max(1.5, target_duration / len(shot_sources)), 1)
    spec = params.get("creation_spec") or {}
    shots = []
    for index, (scene_index, line) in enumerate(shot_sources, 1):
        scene_index = min(scene_index, len(scenes) - 1)
        dialogue_match = DIALOGUE.match(line)
        dialogue = dialogue_match.group(2).strip() if dialogue_match else ""
        speaker = dialogue_match.group(1).strip() if dialogue_match else ""
        action = "{0}说：{1}".format(speaker, dialogue) if dialogue_match else line
        character_ids = [character_mapping[speaker]] if speaker in character_mapping else [characters[0]["id"]]
        start_time = round((index - 1) * duration, 2)
        end_time = round(start_time + duration, 2)
        scene_lock = scenes[scene_index]["description"]
        character_lock = "\n".join(
            "{0}｜{1}".format(character["name"], character.get("appearance_lock") or character["appearance"]["face"])
            for character in characters if character["id"] in character_ids
        )
        constraints = "角色不一致，多余肢体，文字水印，低清晰度"
        shots.append({
            "id": "A-{0:03d}".format(index),
            "sequence_id": "SEQ_{0:03d}".format(scene_index + 1),
            "scene_id": scenes[scene_index]["id"],
            "character_ids": character_ids,
            "source_time_range": {"start": start_time, "end": end_time},
            "duration": duration,
            "aspect_ratio": str(spec.get("aspect_ratio") or ""),
            "shot_size": "MEDIUM" if dialogue else "WIDE",
            "camera_angle": "EYE_LEVEL",
            "camera_movement": "STATIC",
            "visual_style": str(spec.get("visual_style") or ""),
            "scene_lock": scene_lock,
            "character_lock": character_lock,
            "visual": line,
            "action": action,
            "emotion": "根据上下文设定",
            "dialogue": dialogue,
            "sound": "待设计",
            "image_prompt": "{0}，{1}".format(scenes[scene_index]["name"], line),
            "video_prompt": "保持角色与场景一致，表现：{0}".format(action),
            "negative_prompt": constraints,
            "constraints": constraints,
            "status": "DRAFT",
            "locked": False,
        })
    report(0.78, "shot_planning", "已规划 {0} 个镜头".format(len(shots)))

    sequences = []
    for index, scene in enumerate(scenes, 1):
        scene_shots = [shot for shot in shots if shot["scene_id"] == scene["id"]]
        sequences.append({
            "id": "SEQ_{0:03d}".format(index),
            "scene_id": scene["id"],
            "order": index,
            "summary": scene["description"],
            "character_ids": sorted({character_id for shot in scene_shots for character_id in shot["character_ids"]}),
            "shot_ids": [shot["id"] for shot in scene_shots],
        })

    title = str(spec.get("project_name") or lines[0][:40])
    canonical = {
        "story": {
            "title": title,
            "logline": lines[0][:240],
            "genre": [script_type],
            "theme": "待在剧情编辑页完善",
            "synopsis": "\n".join(lines[:8])[:1000],
            "tone": "根据原始剧本",
            "aspect_ratio": str(spec.get("aspect_ratio") or "9:16"),
            "visual_style": str(spec.get("visual_style") or ""),
        },
        "characters": characters,
        "scenes": scenes,
        "sequences": sequences,
        "shots": shots,
        "metadata": {"script_type": script_type, "source_character_count": len(text)},
    }
    report(1.0, "completed", "剧本分析完成")
    return canonical
