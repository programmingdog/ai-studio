export const creditText = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
export const creditRefundCopy = "生成失败会退回积分；已生成内容但需要调整，本次仍会扣分。";
export const creditRetryCopy = "重做或继续下一步时，所需积分仍由你确认。";

export function creditAction(operation: string, capability: string): string {
  if (operation.includes("二创")) return "二创";
  if (operation.includes("Agent") || operation.includes("助手")) return "助手处理";
  if (operation.includes("角色") && capability === "IMAGE_GENERATION") return "角色图生成";
  if (operation.includes("场景") && capability === "IMAGE_GENERATION") return "场景图生成";
  if (operation.includes("分镜") && capability === "IMAGE_GENERATION") return "分镜图生成";
  if (operation.includes("大纲")) return "大纲生成";
  if (operation.includes("分集") || operation.includes("分段")) return "分集剧情生成";
  if (operation.includes("设定")) return "角色和场景设定";
  if (operation.includes("分镜") && capability === "TEXT_GENERATION") return "分镜创作";
  return ({ TEXT_GENERATION: "内容生成", VIDEO_UNDERSTANDING: "视频解析", IMAGE_GENERATION: "图片生成", VIDEO_GENERATION: "视频生成" } as Record<string, string>)[capability] || "生成";
}

export function creditNotice(action: string, credits: number): string {
  return credits === 0 ? `本次${action}免费，不扣积分。` : `本次${action}需要扣 ${creditText(credits)} 积分。${creditRefundCopy}`;
}
