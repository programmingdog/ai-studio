import { BadGatewayException, BadRequestException } from "@nestjs/common";
import { validateNormalizedScript } from "./script-normalization";

type Row = Record<string, any>;

export interface ScriptChunk {
  index: number;
  text: string;
  label: string;
  episodeNumber: number;
  episodeTitle: string;
}

const episodeHeading = /^第\s*([零一二三四五六七八九十百\d]+)\s*集(?:[：:\s]+(.+))?\s*$/;
const maxChunkCharacters = 3_800;
const maximumChunks = 160;

function episodeNumberFromText(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character === "十" || character === "百") {
      total += (current || 1) * (character === "十" ? 10 : 100);
      current = 0;
    } else current = digits[character] ?? current;
  }
  return total + current;
}

/** Split on episode or line boundaries without removing a single source character. */
export function splitScriptText(source: string): ScriptChunk[] {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
  const chunks: ScriptChunk[] = [];
  let current = "";
  let episodeNumber = 1;
  let episodeTitle = "完整剧本";
  let hasEpisode = false;
  const flush = () => {
    if (!current.trim()) return;
    chunks.push({ index: chunks.length, text: current, label: `第${episodeNumber}集·第${chunks.length + 1}段`, episodeNumber, episodeTitle });
    current = "";
  };
  for (const line of lines) {
    const heading = episodeHeading.exec(line.trim());
    if (heading) {
      if ((hasEpisode || current.length + line.length > maxChunkCharacters) && current.trim()) flush();
      episodeNumber = episodeNumberFromText(heading[1]!);
      episodeTitle = heading[2]?.trim() || `第${episodeNumber}集`;
      hasEpisode = true;
    }
    if (current.length + line.length > maxChunkCharacters && current.trim() && !heading) flush();
    if (line.length > maxChunkCharacters) {
      let rest = line;
      while (rest.length > maxChunkCharacters) {
        if (current.trim()) flush();
        current = rest.slice(0, maxChunkCharacters);
        flush();
        rest = rest.slice(maxChunkCharacters);
      }
      current += rest;
    } else {
      current += line;
    }
    if (chunks.length > maximumChunks) throw new BadRequestException(`剧本超过分段处理上限（${maximumChunks}段）；请按故事分成多个项目`);
  }
  flush();
  if (!chunks.length) throw new BadRequestException("剧本没有可解析的正文");
  if (chunks.length > maximumChunks) throw new BadRequestException(`剧本超过分段处理上限（${maximumChunks}段）；请按故事分成多个项目`);
  if (chunks.map(chunk => chunk.text).join("") !== source) throw new Error("剧本分段过程丢失了原文");
  return chunks;
}

function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : []; }
function nameKey(value: unknown): string { return String(value || "").trim().replace(/\s+/g, "").toLocaleLowerCase(); }
function copy<T>(value: T): T { return structuredClone(value); }
function id(prefix: string, index: number): string { return `${prefix}_${String(index).padStart(3, "0")}`; }

/** Merge independently validated segment JSONs; the model never receives the entire output again. */
export function mergeScriptChunks(chunks: ScriptChunk[], parts: Row[]): Row {
  if (!chunks.length || chunks.length !== parts.length) throw new BadGatewayException("剧本分段结果数量不完整");
  const output: Row = { story: copy(parts[0]?.story || {}), episodes: [], characters: [], scenes: [], props: [], sequences: [], shots: [] };
  const characterKeys = new Map<string, Row>();
  const sceneKeys = new Map<string, Row>();
  const propKeys = new Map<string, Row>();
  const episodeKeys = new Map<number, Row>();
  const synopsis: string[] = [];
  let cursor = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    const part = validateNormalizedScript(copy(parts[index]!));
    const originalCharacters = new Map(rows(part.characters).map(value => [String(value.id), value]));
    const originalScenes = new Map(rows(part.scenes).map(value => [String(value.id), value]));
    const originalProps = new Map(rows(part.props).map(value => [String(value.id), value]));
    const characterIdMap = new Map<string, string>();
    const stateIdMap = new Map<string, string>();
    const sceneIdMap = new Map<string, string>();
    const propIdMap = new Map<string, string>();
    for (const value of originalCharacters.values()) {
      const key = nameKey(value.name);
      if (!key) throw new BadGatewayException(`第${index + 1}段角色缺少名称`);
      let global = characterKeys.get(key);
      if (!global) {
        global = copy(value);
        global.id = id("CHAR", output.characters.length + 1);
        global.states = rows(global.states).map((state, stateIndex) => ({ ...state, id: `${global!.id}_STATE_${String(stateIndex + 1).padStart(3, "0")}` }));
        output.characters.push(global);
        characterKeys.set(key, global);
      }
      characterIdMap.set(String(value.id), String(global.id));
      for (const [stateIndex, state] of rows(value.states).entries()) {
        const matching = rows(global.states).find(item => nameKey(item.name) === nameKey(state.name))
          || rows(global.states).find(item => nameKey(item.appearance_lock) === nameKey(state.appearance_lock)
            && nameKey(item.clothing_lock) === nameKey(state.clothing_lock));
        if (matching) stateIdMap.set(String(state.id), String(matching.id));
        else {
          const added = { ...copy(state), id: `${global.id}_STATE_${String(rows(global.states).length + 1).padStart(3, "0")}` };
          global.states.push(added);
          stateIdMap.set(String(state.id), added.id);
        }
        if (!stateIdMap.has(String(state.id))) throw new BadGatewayException(`第${index + 1}段角色造型映射失败：${stateIndex + 1}`);
      }
    }
    for (const value of originalScenes.values()) {
      const key = nameKey(value.name);
      if (!key) throw new BadGatewayException(`第${index + 1}段场景缺少名称`);
      let global = sceneKeys.get(key);
      if (!global) {
        global = { ...copy(value), id: id("SCENE", output.scenes.length + 1) };
        output.scenes.push(global);
        sceneKeys.set(key, global);
      }
      sceneIdMap.set(String(value.id), String(global.id));
    }
    for (const value of originalProps.values()) {
      const key = nameKey(value.name);
      if (!key) throw new BadGatewayException(`第${index + 1}段道具缺少名称`);
      let global = propKeys.get(key);
      if (!global) {
        global = { ...copy(value), id: id("PROP", output.props.length + 1) };
        output.props.push(global);
        propKeys.set(key, global);
      }
      propIdMap.set(String(value.id), String(global.id));
    }
    const sequenceMap = new Map<string, Row>();
    for (const value of rows(part.sequences)) {
      const sceneId = sceneIdMap.get(String(value.scene_id));
      if (!sceneId) throw new BadGatewayException(`第${index + 1}段序列场景引用无效`);
      const global = { ...copy(value), id: id("SEQ", output.sequences.length + 1), scene_id: sceneId,
        order: output.sequences.length + 1, character_ids: [], shot_ids: [] };
      output.sequences.push(global);
      sequenceMap.set(String(value.id), global);
    }
    let episode = episodeKeys.get(chunk.episodeNumber);
    if (!episode) {
      episode = { id: id("EP", output.episodes.length + 1), order: output.episodes.length + 1,
        title: chunk.episodeTitle, duration: 0, content: "" };
      output.episodes.push(episode);
      episodeKeys.set(chunk.episodeNumber, episode);
    }
    episode.content += chunk.text;
    for (const value of rows(part.shots)) {
      const sequence = sequenceMap.get(String(value.sequence_id));
      const sceneId = sceneIdMap.get(String(value.scene_id));
      if (!sequence || !sceneId || sequence.scene_id !== sceneId) throw new BadGatewayException(`第${index + 1}段镜头场景引用无效`);
      const characterIds = Array.isArray(value.character_ids)
        ? value.character_ids.map((raw: unknown) => characterIdMap.get(String(raw))) : [];
      if (characterIds.some((mapped: unknown) => !mapped)) throw new BadGatewayException(`第${index + 1}段镜头角色引用无效`);
      const stateIds: Record<string, string> = {};
      for (const [rawCharacterId, rawStateId] of Object.entries(value.character_state_ids || {})) {
        const mappedCharacter = characterIdMap.get(rawCharacterId);
        const mappedState = stateIdMap.get(String(rawStateId));
        if (!mappedCharacter || !mappedState) throw new BadGatewayException(`第${index + 1}段镜头造型引用无效`);
        stateIds[mappedCharacter] = mappedState;
      }
      const propIds = Array.isArray(value.prop_ids) ? value.prop_ids.map((raw: unknown) => propIdMap.get(String(raw))) : [];
      if (propIds.some((mapped: unknown) => !mapped)) throw new BadGatewayException(`第${index + 1}段镜头道具引用无效`);
      const duration = Number(value.duration);
      const shot = { ...copy(value), id: id("SHOT", output.shots.length + 1), episode_id: episode.id,
        sequence_id: sequence.id, scene_id: sceneId, character_ids: characterIds,
        character_state_ids: stateIds, prop_ids: propIds,
        time_range: { start: cursor, end: Math.round((cursor + duration) * 1000) / 1000 },
        source_time_range: { start: cursor, end: Math.round((cursor + duration) * 1000) / 1000 } };
      output.shots.push(shot);
      sequence.shot_ids.push(shot.id);
      sequence.character_ids = [...new Set([...sequence.character_ids, ...characterIds])];
      cursor = shot.time_range.end;
      episode.duration = Math.round((Number(episode.duration) + duration) * 1000) / 1000;
    }
    if (String(part.story?.synopsis || "").trim()) synopsis.push(String(part.story.synopsis).trim());
  }
  output.story.synopsis = synopsis.join("\n");
  output.story.beats = output.episodes.map((episode: Row, index: number) => ({ id: id("BEAT", index + 1), type: "EPISODE", description: episode.title }));
  output.metadata = { script_type: "AI_CHUNKED_SCRIPT", chunk_count: chunks.length,
    episode_count: output.episodes.length, shot_count: output.shots.length };
  return validateNormalizedScript(output);
}
