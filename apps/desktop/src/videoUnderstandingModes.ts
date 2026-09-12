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
1. 必须从0秒开始，按每段最多${seconds}秒连续定位原视频：第1段为0～${seconds}秒，第2段为${seconds}～${seconds * 2}秒，依此类推；最后一段标题的结束秒数保留原视频真实结尾。
2. 每段标题下一行必须额外输出“生成时长：${seconds}秒”。每一个分镜的生成时长都必须恰好等于${seconds}秒，最后一个分镜也不例外；绝对不得输出任何其他生成时长。
3. 视频最后剩余内容不足${seconds}秒时，仍须生成一个完整${seconds}秒分镜：真实内容结束后保持最后一个有意义的画面状态，不得新增剧情、台词、人物或动作。
4. 场景或镜头在固定分镜内部发生切换时，应在该分镜的画面、动作和运镜中按时间顺序描述，不得因此提前结束当前分镜。
5. 输出前逐段校验“生成时长”字段，确保包括最后一段在内的全部分镜均为${seconds}秒；原片定位时间轴必须首尾衔接且覆盖视频真实结尾。`;
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
