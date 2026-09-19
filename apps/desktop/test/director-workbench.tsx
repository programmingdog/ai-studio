import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirectorWorkbench } from "../src/components/DirectorWorkbench";
import { ScriptFileInput } from "../src/components/ScriptFileInput";
import example from "../src/data/standard-script-example.json";
import type { CanonicalProject, GenerationRecord } from "@aivs/schemas";
import "../src/styles.css";

const canonical = { ...example, shots: Array.from({ length: 8 }, (_, index) => ({ ...example.shots[index % 2], id: `SHOT_${String(index + 1).padStart(3, "0")}`, duration: [7, 12, 9, 6][index % 4], character_state_ids: {}, reference_assets: [], video_assets: [] })) } as unknown as CanonicalProject;
const records = [
  { id: "running", target_id: "SHOT_001", target_type: "shot", media_type: "video", status: "REMOTE_PROCESSING", progress: 0.4 },
  { id: "failed", target_id: "SHOT_002", target_type: "shot", media_type: "video", status: "FAILED" },
  { id: "completed", target_id: "SHOT_003", target_type: "shot", media_type: "video", status: "COMPLETED", result_relative_path: "example.mp4" },
] as GenerationRecord[];
function Preview() {
  const [selected, setSelected] = useState("SHOT_001");
  if (new URLSearchParams(location.search).has('script')) return <section className="create-card create-workspace-panel"><ScriptFileInput sourcePath="" onSelect={() => setSelected("选择文件")} /><div className="script-analysis-notice">完整剧本将整理为规范分镜剧本</div><div className="script-create-project-action"><button className="primary-button">创建本地项目（分析剧本需积分）</button></div></section>;
  return <main style={{ padding: 28, minHeight: "100vh", background: "var(--ui-surface-subtle)" }}><DirectorWorkbench canonical={canonical} projectPath="preview" records={records} imageTasks={[]} selectedId={selected} videoPrompt={'镜头从窗外雨水缓慢推进。\n人物保持坐姿并轻微抬头。\n玻璃上的雨滴清晰可见。\n室内使用冷色调柔光。\n镜头在人物侧脸处短暂停留。\n最后缓慢拉远并淡出。'} getVideoPrompt={shot => `${shot.id} 的完整视频生成提示词。镜头从窗外雨水缓慢推进，人物保持坐姿并轻微抬头，玻璃上的雨滴清晰可见，室内使用冷色调柔光，最后缓慢拉远并淡出。`} onSelect={setSelected} onOpenDetail={id => setSelected(`详情:${id}`)} onGenerateImage={id => setSelected(`生图:${id}`)} onGenerateVideo={id => setSelected(`视频:${id}`)} onEditVideoPrompt={id => setSelected(`编辑:${id}`)} actions={<><button className="secondary-button">一键生成所有分镜视频</button><button className="primary-button">一键合成视频</button></>} /><p role="status">当前分镜：{selected}</p></main>;
}
// Isolate component responsiveness from the desktop shell's 1080px minimum.
document.body.style.minWidth = "0";
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Preview /></QueryClientProvider>);
