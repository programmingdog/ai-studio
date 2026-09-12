import type { CanonicalProject, Shot } from "@aivs/schemas";

function nextNumberedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  const pattern = new RegExp(`^${prefix}_(\\d+)$`);
  let number = ids.reduce((largest, id) => {
    const match = pattern.exec(id);
    return match ? Math.max(largest, Number(match[1])) : largest;
  }, 0) + 1;
  let candidate = `${prefix}_${String(number).padStart(3, "0")}`;
  while (used.has(candidate)) {
    number += 1;
    candidate = `${prefix}_${String(number).padStart(3, "0")}`;
  }
  return candidate;
}

export function addManualShot(model: CanonicalProject, anchorShotId?: string): { canonical: CanonicalProject; shotId: string } {
  const anchor = model.shots.find((shot) => shot.id === anchorShotId);
  const anchorSequence = anchor ? model.sequences.find((sequence) => sequence.id === anchor.sequence_id) : undefined;
  let sceneId = anchorSequence?.scene_id ?? anchor?.scene_id ?? model.scenes[0]?.id ?? "";
  let targetSequence = anchorSequence
    ?? (sceneId ? model.sequences.find((sequence) => sequence.scene_id === sceneId) : model.sequences[0]);
  let sequences = [...model.sequences];

  if (targetSequence) {
    sceneId = targetSequence.scene_id || sceneId;
  } else if (sceneId) {
    const sequenceId = nextNumberedId(model.sequences.map((sequence) => sequence.id), "SEQ");
    targetSequence = {
      id: sequenceId,
      scene_id: sceneId,
      order: Math.max(0, ...model.sequences.map((sequence) => sequence.order)) + 1,
      summary: "手动添加的分镜序列",
      character_ids: [],
      shot_ids: [],
    };
    sequences.push(targetSequence);
  }

  const shotId = nextNumberedId(model.shots.map((shot) => shot.id), "SHOT");
  const scene = model.scenes.find((item) => item.id === sceneId);
  const shot: Shot = {
    id: shotId,
    sequence_id: targetSequence?.id ?? "",
    scene_id: sceneId,
    character_ids: [],
    character_state_ids: {},
    duration: 5,
    aspect_ratio: model.story.aspect_ratio || anchor?.aspect_ratio || "9:16",
    shot_size: "中景",
    camera_angle: "平视",
    camera_movement: "固定",
    visual_style: model.story.visual_style || anchor?.visual_style || "",
    scene_lock: scene?.description ?? anchor?.scene_lock ?? "",
    character_lock: "",
    visual: "",
    action: "",
    emotion: "",
    dialogue: "",
    sound: "",
    image_prompt: "",
    video_prompt: "",
    negative_prompt: "角色不一致，多余手指，畸形肢体，文字水印",
    constraints: "角色不一致，多余手指，畸形肢体，文字水印",
    reference_assets: [],
    video_assets: [],
    status: "DRAFT",
    locked: false,
  };

  const shots = [...model.shots];
  const anchorIndex = anchor ? shots.findIndex((item) => item.id === anchor.id) : -1;
  shots.splice(anchorIndex >= 0 ? anchorIndex + 1 : shots.length, 0, shot);

  sequences = sequences.map((sequence) => {
    const shotIds = sequence.shot_ids.filter((id) => id !== shotId);
    if (sequence.id !== targetSequence?.id) return { ...sequence, shot_ids: shotIds };
    const sequenceAnchorIndex = anchor?.sequence_id === sequence.id ? shotIds.indexOf(anchor.id) : -1;
    shotIds.splice(sequenceAnchorIndex >= 0 ? sequenceAnchorIndex + 1 : shotIds.length, 0, shotId);
    return { ...sequence, shot_ids: shotIds };
  });

  return { canonical: { ...model, sequences, shots }, shotId };
}

function sequencesWithOrderedShots(model: CanonicalProject, shots: Shot[]): CanonicalProject["sequences"] {
  return model.sequences.map((sequence) => ({
    ...sequence,
    shot_ids: shots.filter((shot) => shot.sequence_id === sequence.id).map((shot) => shot.id),
  }));
}

export function deleteStoryboardShot(model: CanonicalProject, shotId: string): { canonical: CanonicalProject; nextShotId: string } {
  const index = model.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) return { canonical: model, nextShotId: model.shots[0]?.id ?? "" };
  const shots = model.shots.filter((shot) => shot.id !== shotId);
  const nextShotId = shots[Math.min(index, shots.length - 1)]?.id ?? "";
  return {
    canonical: { ...model, sequences: sequencesWithOrderedShots(model, shots), shots },
    nextShotId,
  };
}

export function moveStoryboardShot(model: CanonicalProject, shotId: string, direction: "up" | "down"): CanonicalProject {
  const index = model.shots.findIndex((shot) => shot.id === shotId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= model.shots.length) return model;
  const shots = [...model.shots];
  [shots[index], shots[targetIndex]] = [shots[targetIndex]!, shots[index]!];
  return { ...model, sequences: sequencesWithOrderedShots(model, shots), shots };
}
