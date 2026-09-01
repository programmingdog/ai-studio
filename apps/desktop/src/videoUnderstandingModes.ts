import { VIDEO_STORYBOARD_DETAILED_PROMPT, VIDEO_STORYBOARD_PROMPT } from "./prompts/videoStoryboard";

export type StoryboardUnderstandingMode = "standard" | "detailed" | "fixed";
export type FixedStoryboardSeconds = 6 | 10 | 15;
export type StoryboardUnderstandingSelection = { mode: StoryboardUnderstandingMode; fixedSeconds?: FixedStoryboardSeconds };

const DETAILED_STORYBOARD_DURATION_GUARD = `

【分镜时长硬性校验（不可忽略）】
输出前逐段计算“结束秒数－开始秒数”。每段必须小于或等于15秒，常规段保持10～15秒并优先使用10秒整数边界；最后一段可不足10秒。任何超过15秒的内容必须拆成多个连续分镜后再输出，时间轴不得重叠或遗漏。

【分镜内部局部时间轴硬性规则（不可忽略）】
分镜标题保留原视频全局起止秒数，但每个分镜“画面”里的子时间段必须独立从0秒开始，最后结束于该分镜自身时长。比如标题为“第2段（10～20秒）”，画面只能使用0～10秒范围，绝对不能使用10～20秒。所有分镜生成提示词也必须使用这个从0开始的局部时间轴。`;

function fixedStoryboardDurationGuard(seconds: FixedStoryboardSeconds): string {
  return `

【固定分镜时长规则（最高优先级，如与前文冲突以本节为准）】
1. 必须从0秒开始，严格按每段${seconds}秒连续切分：第1段为0～${seconds}秒，第2段为${seconds}～${seconds * 2}秒，第3段为${seconds * 2}～${seconds * 3}秒，依此类推。
2. 除视频最后一段外，每个分镜的“结束秒数－开始秒数”必须恰好等于${seconds}秒，不得生成更长或更短的常规分镜。
3. 视频最后一段不足${seconds}秒时按真实剩余时长输出，不得为了凑满时长虚构、重复或延长内容。
4. 场景或镜头在固定分镜内部发生切换时，应在该分镜的画面、动作和运镜中按时间顺序描述，不得因此提前结束当前分镜。
5. 输出前逐段计算并校验时长，确保时间轴首尾衔接、无重叠、无遗漏，并覆盖到视频真实结尾。`;
}

export function buildVideoUnderstandingPrompt(
  selection: StoryboardUnderstandingSelection,
  standardPrompt?: string,
  detailedPrompt?: string,
): string {
  const basePrompt = selection.mode === "detailed"
    ? `${detailedPrompt || VIDEO_STORYBOARD_DETAILED_PROMPT}${DETAILED_STORYBOARD_DURATION_GUARD}`
    : standardPrompt || VIDEO_STORYBOARD_PROMPT;
  return selection.mode === "fixed"
    ? `${basePrompt}${fixedStoryboardDurationGuard(selection.fixedSeconds ?? 10)}`
    : basePrompt;
}
