/** HuiXin API center model 83, bodyConfig/pricingConfig verified 2026-11-02. */
export const allaiinMuseVideo = {
  remoteId: 83,
  modelCode: "muse-video",
  alias: "Muse-video",
  maxReferenceImages: 7,
  pointsPerSecond: 0.8,
  durations: [5, 10, 15, 20, 25, 30],
  resolutions: ["720P"],
  aspectRatios: ["9:16", "16:9"],
  notice: "Muse-video 当前为预览模型，供应商提示生成结果不提供售后；请选择后再确认生成。",
  config: {
    reference_image_mode: "reference_images",
    video_duration_options: [5, 10, 15, 20, 25, 30],
    aspect_ratio_options: ["9:16", "16:9"],
    resolution_mapping: { "720p": "720P" },
    manual_resolution_pricing: true,
  },
};

export function allaiinMuseVideoSchema(): Record<string, unknown>[] {
  return [
    { name: "prompt", label: "提示词", type: "textarea", required: true },
    { name: "size", label: "视频比例", type: "select", required: false, options: allaiinMuseVideo.aspectRatios },
    { name: "seconds", label: "视频时长", type: "select", required: true, options: allaiinMuseVideo.durations },
    { name: "resolution", label: "分辨率", type: "select", required: true, options: allaiinMuseVideo.resolutions },
    { name: "count", label: "生成数量", type: "select", required: false, options: [1, 2, 3, 4] },
    { name: "reference_image", label: "参考图", type: "upload", required: false },
    { name: "reference_images", label: "多张参考图", type: "upload", required: false, description: "最多 7 张公网图片 URL；分镜图排在第一张。" },
    { name: "reference_video", label: "参考视频", type: "upload", required: false, description: "最多 1 段公网视频 URL，费用不加倍。" },
    { name: "reference_videos", label: "参考视频数组", type: "upload", required: false, description: "最多 1 段，与单个参考视频合计。" },
  ];
}
