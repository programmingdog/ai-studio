import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clapperboard, FileVideo2, LoaderCircle, ScanSearch, Upload } from "lucide-react";
import type { LocalVideoMetadata } from "@aivs/schemas";
import { chooseVideoFile, createLocalVideoUnderstandingTask, getAiSettings, probeLocalVideo } from "../services/backend";
import { useI18n } from "../i18n";
import { ModelCreditNotice } from "./CreditConfirmationHost";
import { buildVideoUnderstandingPrompt, type StoryboardUnderstandingSelection } from "../videoUnderstandingModes";

function readableError(error: unknown): string {
  const value = String(error ?? "发生未知错误");
  try { return (JSON.parse(value) as { message?: string }).message || value; } catch { return value; }
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function VideoUnderstandingPanel({ onRequestModeSelection, onTaskCreated, records }: { onRequestModeSelection: (handler: (selection: StoryboardUnderstandingSelection) => void) => void; onTaskCreated: () => Promise<void>; records?: ReactNode }) {
  const { t } = useI18n();
  const [videoPath, setVideoPath] = useState("");
  const [videoMetadata, setVideoMetadata] = useState<LocalVideoMetadata>();
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const probeVideo = useMutation({
    mutationFn: probeLocalVideo,
    onSuccess: setVideoMetadata,
  });
  const createTask = useMutation({ mutationFn: async (selection: StoryboardUnderstandingSelection) => {
    if (!videoMetadata) throw new Error("请等待视频时长读取完成");
    await createLocalVideoUnderstandingTask({
      video_path: videoPath,
      prompt: buildVideoUnderstandingPrompt(selection, settings.data?.video_storyboard_prompt, settings.data?.video_storyboard_detailed_prompt),
      mode: selection.mode,
      fixed_seconds: selection.fixedSeconds,
    });
    setVideoPath("");
    setVideoMetadata(undefined);
    await onTaskCreated();
  } });

  const pickVideo = async () => {
    const selected = await chooseVideoFile();
    if (selected) {
      setVideoPath(selected);
      setVideoMetadata(undefined);
      createTask.reset();
      probeVideo.reset();
      probeVideo.mutate(selected);
    }
  };

  return <div className="video-understanding-panel">
    <ModelCreditNotice capability="VIDEO_UNDERSTANDING" />
    <label>{t("uploadVideo")}<button className="file-picker video-picker" type="button" onClick={pickVideo}>{probeVideo.isPending ? <LoaderCircle className="spin" size={22} /> : videoPath ? <FileVideo2 size={22} /> : <Upload size={22} />}<span><strong>{videoPath ? videoPath.split(/[\\/]/).pop() : t("selectVideo")}</strong><small>{probeVideo.isPending ? "正在读取完整视频时长与画面尺寸…" : videoMetadata ? `${formatDuration(videoMetadata.duration)} · ${videoMetadata.duration.toFixed(2)}秒 · ${videoMetadata.width}×${videoMetadata.height} · ${videoMetadata.aspect_ratio}` : videoPath || "MP4 / MOV / AVI / WEBM · 提交前自动读取真实时长"}</small></span></button></label>
    {probeVideo.error && <div className="error-banner">视频信息读取失败：{readableError(probeVideo.error)}</div>}
    {createTask.error && <div className="error-banner">{readableError(createTask.error)}</div>}
    <div className="video-understanding-start-action"><button className="primary-button analyze-button" type="button" onClick={() => onRequestModeSelection((selection) => createTask.mutate(selection))} disabled={createTask.isPending || probeVideo.isPending || !videoPath || !videoMetadata || settings.isLoading}>
      {createTask.isPending ? <><LoaderCircle className="spin" size={18} /> 正在提交任务…</> : <><ScanSearch size={18} /> 开始视频理解</>}
    </button></div>
    {records}
    <p className="resolver-notice"><Clapperboard size={13} /> 本地视频会先在客户端压缩，再上传到服务端默认视频理解模型；本机压缩临时文件会在提交后自动删除。</p>
  </div>;
}
