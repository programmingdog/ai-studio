import { AlertTriangle } from "lucide-react";

export function VideoContentReviewTip() {
  return <span className="video-content-review-tip" role="note">
    <AlertTriangle size={14} aria-hidden="true" />
    <span>为提高审核通过率，请尽量避免家暴、虐待老人及涉及未成年人的内容；若此类内容导致生成失败，可更换其他模型后重试。</span>
  </span>;
}
