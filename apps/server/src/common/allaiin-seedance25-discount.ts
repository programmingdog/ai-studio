/** HuiXin API center, model 81 (verified 2026-11-01). */
export const allaiinSeedance25Discount = {
  remoteId: 81,
  modelCode: "xh-seedance-2.5-c-zk",
  alias: "Seedance 2.5 特惠版",
  maxReferenceImages: 30,
  durations: [15, 30],
  resolutions: ["720P"],
  aspectRatios: ["9:16", "16:9", "4:3", "3:4", "1:1", "21:9"],
  config: {
    reference_image_mode: "reference_images",
    video_duration_options: [15, 30],
    aspect_ratio_options: ["9:16", "16:9", "4:3", "3:4", "1:1", "21:9"],
    resolution_mapping: { "720p": "720P" },
  },
};

export function allaiinSeedance25DiscountSchema(): Record<string, unknown>[] {
  return [
    { name: "prompt", label: "提示词", type: "textarea", required: true },
    { name: "size", label: "视频比例", type: "select", required: false, options: allaiinSeedance25Discount.aspectRatios },
    { name: "seconds", label: "视频时长", type: "select", required: true, options: allaiinSeedance25Discount.durations },
    { name: "resolution", label: "分辨率", type: "select", required: false, options: allaiinSeedance25Discount.resolutions },
    { name: "count", label: "生成数量", type: "select", required: false, options: [1, 2, 3, 4] },
    { name: "reference_image", label: "参考图", type: "upload", required: false },
    { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "最多 30 张公网图片 URL；分镜图排在第一张。" },
  ];
}
