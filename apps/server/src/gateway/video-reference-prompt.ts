export interface VideoReferenceImage {
  type?: string;
  label?: string;
}

const priorities: Record<string, number> = { shot_first_frame: 0, scene: 1, character: 2, prop: 3, shot_reference: 5 };

/** Keep distinct image roles, even when two references contain the same pixels. */
export function orderedVideoReferenceImages<T extends VideoReferenceImage>(references: T[]): T[] {
  return references.map((reference, index) => ({ reference, index }))
    .sort((a, b) => (priorities[a.reference.type || ""] ?? 4) - (priorities[b.reference.type || ""] ?? 4) || a.index - b.index)
    .map(({ reference }) => reference);
}

function relationship(reference: VideoReferenceImage, index: number): string {
  const ordinal = `图${index + 1}`;
  const label = reference.label?.trim() || "参考图";
  if (reference.type === "shot_first_frame") return `${ordinal}是本视频的分镜图，并作为视频首帧；从该画面自然开始运动。`;
  if (reference.type === "shot_reference") return `${ordinal}为本视频的分镜图，作为整体画面参考，不要求作为视频首帧。`;
  if (reference.type === "scene") {
    const name = label.replace(/^场景\s*[“"「]?/, "").replace(/[”"」]$/, "");
    return `${ordinal}为本视频场景“${name}”，保持空间、构图和光影一致。`;
  }
  if (reference.type === "character") {
    const match = /^角色\s*[“"「]([^”"」]+)[”"」](?:[·｜|]\s*(.+))?$/.exec(label);
    const name = match?.[1] ?? label.replace(/^角色\s*/, "");
    return `${ordinal}为角色${name}的三视图${match?.[2] ? `（状态：${match[2]}）` : ""}，保持人物外貌、服装和道具一致。`;
  }
  if (reference.type === "prop") {
    const name = label.replace(/^道具\s*[“"「]?/, "").replace(/[”"」]$/, "");
    return `${ordinal}为道具“${name}”，保持外观和材质一致。`;
  }
  return `${ordinal}为${label}。`;
}

/** Rebuild the generated guide from exactly the images sent in this request. */
export function withVideoReferenceRelationships(prompt: string, references: VideoReferenceImage[], originalReferences: VideoReferenceImage[] = references): string {
  const clean = prompt
    .replace(/【参考图片对应关系】[\s\S]*?(?:【参考图片对应关系结束】|$)/g, "")
    .replace(/(?:\r?\n){0,2}参考图对应关系：\s*\r?\n(?:[ \t]*第\d+张：[^\n]*(?:\n|$))+/g, "")
    .trim();
  // Older clients had already expanded @ tokens before placing the first
  // frame last. Move their prose references with the image, in one pass.
  const ordinalPrompt = clean.replace(/(参考图|(?<!角色|道具|场景|分镜|@)图)(\d+)(?!\d)/g, (text, prefix, number) => {
    const previous = originalReferences[Number(number) - 1];
    const next = previous ? references.indexOf(previous) : -1;
    return next >= 0 ? `${prefix}${next + 1}` : text;
  });
  return references.length ? [ordinalPrompt, "【参考图片对应关系】", "图片编号严格对应本次实际提交的附件顺序：",
    ...references.map(relationship), "【参考图片对应关系结束】"].filter(Boolean).join("\n") : clean;
}
