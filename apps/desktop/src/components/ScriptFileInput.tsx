import { useState } from "react";
import { FileDown, Upload } from "lucide-react";
import standardScriptExample from "../data/standard-script-example.txt?raw";
import { saveTextAsTxt } from "../services/backend";

export function ScriptFileInput({ sourcePath, onSelect }: { sourcePath: string; onSelect: () => void }) {
  const [error, setError] = useState("");
  const download = async () => {
    setError("");
    try { await saveTextAsTxt(standardScriptExample, "逐梦帧-规范剧本示例.txt"); }
    catch (value) { setError(`下载示例失败：${value instanceof Error ? value.message : String(value)}`); }
  };
  return <div className="script-file-field"><span id="script-file-label">剧本文件</span><div className="script-file-upload-row"><button className="file-picker" type="button" aria-labelledby="script-file-label script-file-selection" onClick={onSelect}><Upload size={18} /><span id="script-file-selection">{sourcePath || "点击选择 TXT、MD、DOCX、PDF 或规范 JSON"}</span></button><button className="secondary-button standard-script-download" type="button" onClick={() => void download()}><FileDown size={16} />下载规范剧本示例</button></div><small>示例为可直接阅读的 TXT。普通剧本会保留原剧情与台词，补全角色、场景和分镜，整理为相同的规范格式；规范 JSON 可直接导入。</small>{error && <div className="error-banner" role="alert">{error}</div>}</div>;
}
