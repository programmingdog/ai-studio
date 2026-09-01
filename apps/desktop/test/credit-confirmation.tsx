import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreditConfirmationDialog, type PendingCredit } from "../src/components/CreditConfirmationHost";
import "../src/styles.css";

const rows: PendingCredit[] = [
  { id: "text", operation: "二创剧情与分镜生成", quote: { provider_model_id: "text", model_alias: "测试文本模型", model_code: "text", capability: "TEXT_GENERATION", credits: 1.5, resolution: null, seconds: null, includes_multiplier: true } },
  { id: "image", operation: "角色图片生成", quote: { provider_model_id: "image", model_alias: "测试图片模型", model_code: "image", capability: "IMAGE_GENERATION", credits: 2.25, resolution: "2K", seconds: null, includes_multiplier: true } },
  { id: "video", operation: "分镜视频生成", quote: { provider_model_id: "video", model_alias: "测试视频模型", model_code: "video", capability: "VIDEO_GENERATION", credits: 18.75, resolution: "1080P", seconds: 5, includes_multiplier: true } },
];
function Fixture() {
  const [mode, setMode] = useState("normal");
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState("尚未确认");
  return <main style={{ padding: 24 }}><h1>积分确认组件测试（不调用模型）</h1><label>测试场景<select value={mode} onChange={event => setMode(event.target.value)}><option value="normal">正常余额</option><option value="remix">本次二创4积分</option><option value="insufficient">积分不足</option><option value="unavailable">余额读取失败</option><option value="free">0积分模型</option></select></label><button className="primary-button" onClick={() => setOpen(true)}>打开确认弹窗</button><p role="status">{decision}</p>{open && <CreditConfirmationDialog items={mode === "remix" ? [{ ...rows[0], quote: { ...rows[0].quote, credits: 4 } }] : mode === "free" ? [{ ...rows[0], quote: { ...rows[0].quote, credits: 0 } }] : rows} available={mode === "unavailable" ? undefined : (mode === "normal" || mode === "remix") ? 100 : 0} balanceError={mode === "unavailable"} onDecision={approved => { setDecision(approved ? "已确认（测试，不扣分）" : "已取消（测试，不扣分）"); setOpen(false); }} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
