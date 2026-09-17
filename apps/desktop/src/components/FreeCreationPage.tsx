import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Check, Clapperboard, Coins, Download, Grid2X2, ImagePlus, List, LoaderCircle, Play, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { AssetLibraryItem, FreeCreationAspectRatio, FreeCreationTask, FreeCreationWorkspace, VisualStylePreset } from "@aivs/schemas";
import { chooseFreeCreationReferenceImage, composeFreeCreationVideos, createFreeCreationVideo, ensureFreeCreationWorkspace, importAssetLibraryReferenceImage, listAssetLibrary, listFreeCreationTasks, saveGenerationRecordAsset } from "../services/backend";
import { getCreditBalance, getMediaCreditQuote, listMediaModels, listVisualStyles, platformApiBaseUrl } from "../services/platform";
import { creditText } from "../services/creditCopy";
import { workflowErrorMessage } from "../services/workflowState";
import { VisualMentionEditor, type VisualMentionItem } from "./VisualMentionEditor";
import { VideoContentReviewTip } from "./VideoContentReviewTip";

type AssetTab = "all" | AssetLibraryItem["asset_type"];
type TaskView = "grid" | "list";
const fallbackAspectRatios: FreeCreationAspectRatio[] = ["9:16", "16:9"];
const aspectRatioLabels: Record<FreeCreationAspectRatio, string> = {
  "9:16": "9:16 竖屏", "16:9": "16:9 横屏", "3:4": "3:4 竖向", "4:3": "4:3 横向", "1:1": "1:1 正方形",
};

const statusLabels: Record<FreeCreationTask["record"]["status"], string> = {
  PENDING: "等待生成", RUNNING: "正在生成", REMOTE_PROCESSING: "模型处理中", DOWNLOADING: "正在下载",
  COMPLETED: "已完成", FAILED: "生成失败", CANCELLED: "已停止",
};
const assetTabLabels: Record<AssetTab, string> = { all: "全部", scene: "场景", character: "角色", prop: "道具" };
const tokenForAsset = (asset: AssetLibraryItem, duplicates: Map<string, number>) => `@${asset.name}${(duplicates.get(asset.name) ?? 0) > 1 ? `（${assetTabLabels[asset.asset_type]}·${asset.id.slice(-4)}）` : ""}`;
const errorText = (error: unknown) => workflowErrorMessage(error);

function FreePromptEditor({ value, onChange, assets, projectPath, maxReferences, selectedAssetIds }: { value: string; onChange: (value: string) => void; assets: AssetLibraryItem[]; projectPath: string; maxReferences?: number; selectedAssetIds: Set<string> }) {
  const duplicates = useMemo(() => assets.reduce((map, asset) => map.set(asset.name, (map.get(asset.name) ?? 0) + 1), new Map<string, number>()), [assets]);
  const items = useMemo<VisualMentionItem[]>(() => assets.map((asset) => ({
    id: asset.id,
    label: asset.name,
    detail: asset.prompt || assetTabLabels[asset.asset_type],
    insertText: tokenForAsset(asset, duplicates),
    relativePath: asset.image_path,
    imageSource: convertFileSrc(asset.image_path),
    group: asset.asset_type,
    disabled: maxReferences !== undefined && selectedAssetIds.size >= maxReferences && !selectedAssetIds.has(asset.id),
  })), [assets, duplicates, maxReferences, selectedAssetIds]);
  return <div className="free-prompt-editor">
    <VisualMentionEditor value={value} onChange={onChange} items={items} projectPath={projectPath} rich picker="asset-modal" placeholder="描述想生成的视频；输入 @ 调用资产库中的图片" ariaLabel="自由创作视频提示词" />
    <VideoContentReviewTip />
    <small>输入 @ 可选择场景、角色或道具图片；可点击标签右侧 ×，或在标签旁按 Backspace / Delete 删除引用。</small>
  </div>;
}

function TaskVideo({ task, controls = false }: { task: FreeCreationTask; controls?: boolean }) {
  const source = task.record.status === "COMPLETED" && task.record.result_absolute_path ? convertFileSrc(task.record.result_absolute_path) : "";
  if (source) return <video src={source} controls={controls} preload="metadata" playsInline />;
  const coverText = Array.from(task.prompt.trim()).slice(0, 2).join("") || (task.kind === "composition" ? "合成" : "视频");
  return <div className={`free-task-placeholder ${task.record.status.toLowerCase()}`}>
    <strong className="free-task-text-cover" aria-label={`文字封面：${coverText}`}>{coverText}</strong>
    <span>{statusLabels[task.record.status]}</span>
    {!(["COMPLETED", "FAILED", "CANCELLED"] as string[]).includes(task.record.status) && <i><b style={{ width: `${Math.round(task.record.progress * 100)}%` }} /></i>}
  </div>;
}

function PreviewModal({ task, workspace, onClose }: { task: FreeCreationTask; workspace: FreeCreationWorkspace; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  return createPortal(<div className="modal-backdrop free-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="free-preview-modal" role="dialog" aria-modal="true"><header><div><span className="section-label">VIDEO PREVIEW</span><h2>{task.kind === "composition" ? "合成视频" : "自由创作视频"}</h2></div><button type="button" className="modal-close" onClick={onClose}><X size={18} /></button></header><main><TaskVideo task={task} controls /></main><footer><span>{message}</span><button className="secondary-button" type="button" disabled={saving} onClick={async () => { setSaving(true); setMessage(""); try { const path = await saveGenerationRecordAsset(workspace.project_path, task.record); if (path) setMessage(`已保存：${path}`); } catch (error) { setMessage(errorText(error)); } finally { setSaving(false); } }}>{saving ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{saving ? "正在保存…" : "保存到本地"}</button><button className="primary-button" type="button" onClick={onClose}>关闭</button></footer></section>
  </div>, document.body);
}

function ComposeModal({ workspace, tasks, onClose }: { workspace: FreeCreationWorkspace; tasks: FreeCreationTask[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [compositionId, setCompositionId] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const completed = tasks.filter((task) => task.kind === "generation" && task.record.status === "COMPLETED" && task.record.result_absolute_path);
  const pages = Math.max(1, Math.ceil(completed.length / 20));
  const rows = completed.slice((page - 1) * 20, page * 20);
  const composition = tasks.find((task) => task.id === compositionId);
  const compose = useMutation({
    mutationFn: () => composeFreeCreationVideos({ workspace, ordered_record_ids: selected }),
    onSuccess: (task) => { setCompositionId(task.id); queryClient.setQueryData<FreeCreationTask[]>(["free-creation-tasks"], (current = []) => [task, ...current]); },
  });
  const move = (index: number, offset: number) => setSelected((current) => { const next = [...current]; const destination = index + offset; if (destination < 0 || destination >= next.length) return current; [next[index], next[destination]] = [next[destination]!, next[index]!]; return next; });
  return createPortal(<div className="modal-backdrop free-compose-backdrop"><section className="free-compose-modal" role="dialog" aria-modal="true">
    <header><div><span className="section-label">VIDEO COMPOSER</span><h2>合成自由创作视频</h2><p>从已完成任务中选择视频，并在右侧调整播放顺序。</p></div><button className="modal-close" type="button" onClick={onClose}><X size={18} /></button></header>
    <main>{composition ? <section className="free-compose-result"><TaskVideo task={composition} controls /><div><strong>{statusLabels[composition.record.status]}</strong><span>{composition.record.status === "COMPLETED" ? "视频已经合成，可播放或保存到本地。" : `合成进度 ${Math.round(composition.record.progress * 100)}%`}</span>{composition.record.error?.message && <p className="error-banner">{composition.record.error.message}</p>}</div></section> : <div className="free-compose-columns"><section><header><strong>已完成的视频</strong><span>共 {completed.length} 个</span></header><div className="free-compose-source-list">{rows.map((task) => { const checked = selected.includes(task.record.id); return <button type="button" key={task.id} className={checked ? "selected" : ""} onClick={() => setSelected((current) => checked ? current.filter((id) => id !== task.record.id) : [...current, task.record.id])}><TaskVideo task={task} /><span><strong>{task.prompt}</strong><small>{task.record.model} · {task.duration} 秒</small></span>{checked && <Check size={16} />}</button>; })}{!rows.length && <p>还没有已完成的视频任务。</p>}</div><footer><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer></section><section><header><strong>已选择 · {selected.length}</strong><span>按以下顺序合成</span></header><div className="free-compose-selected-list">{selected.map((recordId, index) => { const task = completed.find((item) => item.record.id === recordId); if (!task) return null; return <article key={recordId}><span>{index + 1}</span><div><strong>{task.prompt}</strong><small>{task.duration} 秒 · {task.record.aspect_ratio}</small></div><button type="button" disabled={index === 0} onClick={() => move(index, -1)} title="上移"><ArrowUp size={14} /></button><button type="button" disabled={index === selected.length - 1} onClick={() => move(index, 1)} title="下移"><ArrowDown size={14} /></button><button type="button" onClick={() => setSelected((current) => current.filter((id) => id !== recordId))} title="移除"><Trash2 size={14} /></button></article>; })}{!selected.length && <p>点击左侧视频加入合成队列。</p>}</div></section></div>}</main>
    <footer><span className={compose.error ? "error" : ""}>{compose.error ? errorText(compose.error) : saveMessage}</span>{composition?.record.status === "COMPLETED" && <button className="secondary-button" type="button" onClick={async () => { try { const path = await saveGenerationRecordAsset(workspace.project_path, composition.record); if (path) setSaveMessage(`已保存：${path}`); } catch (error) { setSaveMessage(errorText(error)); } }}><Download size={15} />保存合成视频</button>}<button className="secondary-button" type="button" onClick={onClose}>关闭</button>{!composition && <button className="primary-button" type="button" disabled={!selected.length || compose.isPending} onClick={() => compose.mutate()}>{compose.isPending ? <LoaderCircle className="spin" size={15} /> : <Clapperboard size={15} />}{compose.isPending ? "正在开始合成…" : "立即合成"}</button>}</footer>
  </section></div>, document.body);
}

function ConfirmGenerationModal({ credits, balance, busy, error, onCancel, onConfirm }: { credits: number; balance?: number; busy: boolean; error?: unknown; onCancel: () => void; onConfirm: () => void }) {
  const insufficient = balance !== undefined && balance < credits;
  return createPortal(<div className="modal-backdrop free-confirm-backdrop"><section className="free-confirm-modal" role="dialog" aria-modal="true"><header><div><span className="section-label">CREDIT CONFIRMATION</span><h2>确认生成视频</h2></div><button className="modal-close" disabled={busy} type="button" onClick={onCancel}><X size={18} /></button></header><main><div><Coins size={24} /><span>本次需要积分</span><strong>{creditText(credits)} 积分</strong></div><p>当前可用积分：{balance === undefined ? "正在查询…" : `${creditText(balance)} 积分`}</p><small>确认后任务将立即提交。生成失败时，未实际完成的费用按平台规则退回。</small>{insufficient && <p className="error-banner">积分不足，还差 {creditText(credits - balance!)} 积分。</p>}{Boolean(error) && <p className="error-banner">{errorText(error)}</p>}</main><footer><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消，不扣分</button><button className="primary-button" type="button" disabled={busy || insufficient || balance === undefined} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{busy ? "正在提交…" : `确认生成（${creditText(credits)} 积分）`}</button></footer></section></div>, document.body);
}

export function FreeCreationPage() {
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["free-creation-workspace"], queryFn: ensureFreeCreationWorkspace, staleTime: Infinity });
  const assets = useQuery({ queryKey: ["asset-library"], queryFn: listAssetLibrary, staleTime: 10_000 });
  const models = useQuery({ queryKey: ["free-creation-models"], queryFn: () => listMediaModels("VIDEO_GENERATION"), staleTime: 30_000 });
  const styles = useQuery({ queryKey: ["visual-styles"], queryFn: listVisualStyles, staleTime: 60_000 });
  const balance = useQuery({ queryKey: ["credit-balance"], queryFn: getCreditBalance, refetchInterval: 15_000 });
  const tasks = useQuery({ queryKey: ["free-creation-tasks"], queryFn: listFreeCreationTasks, enabled: Boolean(workspace.data), refetchInterval: 1500 });
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [resolution, setResolution] = useState("");
  const [duration, setDuration] = useState(10);
  const [aspectRatio, setAspectRatio] = useState<FreeCreationAspectRatio>("9:16");
  const [styleId, setStyleId] = useState("");
  const [view, setView] = useState<TaskView>("grid");
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<FreeCreationTask>();
  const [showCompose, setShowCompose] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState("");
  const [taskSaveResult, setTaskSaveResult] = useState<{ taskId: string; message: string; error: boolean }>();
  const [importingReference, setImportingReference] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const model = models.data?.find((item) => item.id === modelId);
  const style = styles.data?.find((item) => item.id === styleId);
  const aspectRatioOptions = model?.aspect_ratio_options?.length ? model.aspect_ratio_options : fallbackAspectRatios;
  useEffect(() => { if (!modelId && models.data?.[0]) { setModelId(models.data[0].id); setResolution(models.data[0].resolution_prices[0]?.resolution ?? ""); setDuration(models.data[0].video_duration_options?.[0] ?? 10); } }, [modelId, models.data]);
  const durationOptions = model?.video_duration_options ?? [];
  const quote = useQuery({ queryKey: ["free-creation-quote", modelId, resolution, duration], queryFn: () => getMediaCreditQuote(modelId, resolution, duration), enabled: Boolean(modelId && resolution && duration >= 1 && duration <= 60), retry: false });
  const nameCounts = useMemo(() => (assets.data ?? []).reduce((map, asset) => map.set(asset.name, (map.get(asset.name) ?? 0) + 1), new Map<string, number>()), [assets.data]);
  const selectedAssets = (assets.data ?? []).filter((asset) => prompt.includes(tokenForAsset(asset, nameCounts)));
  const selectedAssetIds = new Set(selectedAssets.map((asset) => asset.id));
  const maxReferences = model?.max_reference_images ?? 0;
  const tooManyReferences = Boolean(model && selectedAssets.length > model.max_reference_images);
  const removeReference = (asset: AssetLibraryItem) => {
    const token = tokenForAsset(asset, nameCounts);
    setPrompt((current) => current.split(token).join("").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim());
    setReferenceError("");
  };
  const addReference = async () => {
    if (!model || importingReference) return;
    if (selectedAssets.length >= maxReferences) {
      setReferenceError(maxReferences > 0 ? `当前模型最多支持 ${maxReferences} 张参考图。` : "当前模型不支持参考图。");
      return;
    }
    setImportingReference(true);
    setReferenceError("");
    try {
      const sourcePath = await chooseFreeCreationReferenceImage();
      if (!sourcePath) return;
      const imported = await importAssetLibraryReferenceImage(sourcePath);
      const currentAssets = queryClient.getQueryData<AssetLibraryItem[]>(["asset-library"]) ?? assets.data ?? [];
      const mergedAssets = currentAssets.some((asset) => asset.id === imported.id) ? currentAssets : [imported, ...currentAssets];
      queryClient.setQueryData<AssetLibraryItem[]>(["asset-library"], mergedAssets);
      const mergedCounts = mergedAssets.reduce((map, asset) => map.set(asset.name, (map.get(asset.name) ?? 0) + 1), new Map<string, number>());
      const token = tokenForAsset(imported, mergedCounts);
      setPrompt((current) => current.includes(token) ? current : `${current.trimEnd()}${current.trim() ? " " : ""}${token}`);
    } catch (error) {
      setReferenceError(errorText(error));
    } finally {
      setImportingReference(false);
    }
  };
  const resetForm = () => {
    const first = models.data?.[0];
    const firstRatios = first?.aspect_ratio_options?.length ? first.aspect_ratio_options : fallbackAspectRatios;
    setPrompt(""); setReferenceError(""); setStyleId(""); setAspectRatio(firstRatios.includes("9:16") ? "9:16" : firstRatios[0]!);
    setModelId(first?.id ?? ""); setResolution(first?.resolution_prices[0]?.resolution ?? ""); setDuration(first?.video_duration_options?.[0] ?? 10);
  };
  const create = useMutation({
    mutationFn: async () => {
      if (!workspace.data || !model || !quote.data) throw new Error("生成参数尚未准备完成");
      const taskId = `FREE_${crypto.randomUUID().replaceAll("-", "")}`;
      const key = `video:shot:${taskId}`;
      const item = { key, provider_model_id: model.id, resolution, seconds: duration, credits: quote.data.credits, capability: "VIDEO_GENERATION" };
      let workflowCreditId = "";
      try {
        workflowCreditId = await invoke<string>("approve_workflow_credit", { projectPath: workspace.data.project_path, apiBase: platformApiBaseUrl, items: [item] });
        return await createFreeCreationVideo({ workspace: workspace.data, task_id: taskId, workflow_credit_id: workflowCreditId, prompt: prompt.trim(), aspect_ratio: aspectRatio, duration, resolution, visual_style_name: style?.name ?? "", visual_style_prompt: style?.prompt ?? "", platform_api_base_url: platformApiBaseUrl, provider_model_id: model.id, provider_code: model.provider_code, model_alias: model.model_alias, references: selectedAssets.map((asset) => ({ asset_id: asset.id })) });
      } catch (error) {
        if (workflowCreditId) await invoke("stop_workflow_credit", { projectPath: workspace.data.project_path, id: workflowCreditId }).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: (task) => { queryClient.setQueryData<FreeCreationTask[]>(["free-creation-tasks"], (current = []) => [task, ...current]); resetForm(); setConfirming(false); void balance.refetch(); },
  });
  const downloadTask = async (task: FreeCreationTask) => {
    if (!workspace.data) return;
    setSavingTaskId(task.id);
    setTaskSaveResult(undefined);
    try {
      const path = await saveGenerationRecordAsset(workspace.data.project_path, task.record);
      if (path) setTaskSaveResult({ taskId: task.id, message: `已保存：${path}`, error: false });
    } catch (error) {
      setTaskSaveResult({ taskId: task.id, message: errorText(error), error: true });
    } finally {
      setSavingTaskId("");
    }
  };
  const ready = Boolean(workspace.data && model && resolution && duration >= 1 && duration <= 60 && prompt.trim().length >= 10 && quote.data && !quote.isFetching && !quote.error && !tooManyReferences);
  const taskRows = tasks.data ?? [];
  return <div className="free-creation-page">
    <section className="free-creation-form"><header><span className="section-label">FREE CREATION</span><h1>自由创作</h1><p>描述画面、选择生成参数后即可提交；任务会在后台并发执行。</p></header>
      <section className="free-reference-picker" aria-label="参考图选择"><header><div><strong>参考图</strong><span>{model ? `${selectedAssets.length} / ${maxReferences}` : "请先选择模型"}</span></div><small>新图片会自动查重并存入资产库，也可在提示词中输入 @ 选择。</small></header><div className="free-reference-grid">{selectedAssets.map((asset) => <article className="free-reference-tile" key={asset.id}><img src={convertFileSrc(asset.image_path)} alt={asset.name} /><span title={asset.name}>{asset.name}</span><button type="button" aria-label={`移除参考图：${asset.name}`} title="移除参考图" onClick={() => removeReference(asset)}><X size={13} /></button></article>)}<button className="free-reference-add" type="button" disabled={!model || importingReference || selectedAssets.length >= maxReferences} onClick={() => void addReference()} aria-label="添加新的参考图" title={!model ? "请先选择视频大模型" : selectedAssets.length >= maxReferences ? `当前模型最多支持 ${maxReferences} 张参考图` : "选择新图片并加入资产库"}>{importingReference ? <LoaderCircle className="spin" size={23} /> : <Plus size={25} />}<span>{importingReference ? "入库中" : "添加"}</span></button></div>{maxReferences === 0 && model && <p><ImagePlus size={14} />当前模型不支持参考图，请切换支持参考图的视频大模型。</p>}{referenceError && <p className="error"><ImagePlus size={14} />{referenceError}</p>}</section>
      <label>视频提示词<FreePromptEditor value={prompt} onChange={setPrompt} assets={assets.data ?? []} projectPath={workspace.data?.project_path ?? ""} maxReferences={model?.max_reference_images} selectedAssetIds={selectedAssetIds} /></label>
      <div className="free-creation-fields"><label>视频大模型<select value={modelId} onChange={(event) => { const next = models.data?.find((item) => item.id === event.target.value); const nextRatios = next?.aspect_ratio_options?.length ? next.aspect_ratio_options : fallbackAspectRatios; setModelId(event.target.value); setResolution(next?.resolution_prices[0]?.resolution ?? ""); setDuration(next?.video_duration_options?.[0] ?? 10); setAspectRatio((current) => nextRatios.includes(current) ? current : nextRatios[0]!); }}><option value="">请选择</option>{models.data?.map((item) => <option key={item.id} value={item.id}>{item.model_alias}{item.recommended ? "（推荐）" : ""}</option>)}</select></label><label>时长{durationOptions.length ? <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{durationOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select> : <span className="unit-input"><input type="number" min={1} max={60} step={1} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><span>秒</span></span>}</label><label>分辨率<select value={resolution} onChange={(event) => setResolution(event.target.value)}>{model?.resolution_prices.map((item) => <option key={item.resolution} value={item.resolution}>{item.label || item.resolution.toUpperCase()}</option>)}</select></label><label>画面比例<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as FreeCreationAspectRatio)}>{aspectRatioOptions.map((ratio) => <option key={ratio} value={ratio}>{aspectRatioLabels[ratio] ?? ratio}</option>)}</select></label><label className="free-style-field">画风<select value={styleId} onChange={(event) => setStyleId(event.target.value)}><option value="">默认画风</option>{Array.from(new Set(styles.data?.map((item) => item.category) ?? [])).flatMap((category) => [<option disabled key={`group-${category}`}>{category}</option>, ...(styles.data ?? []).filter((item) => item.category === category).map((item: VisualStylePreset) => <option key={item.id} value={item.id}>　{item.name}</option>)])}</select></label></div>
      {tooManyReferences && <p className="error-banner">当前模型最多支持 {model?.max_reference_images} 张参考图，请从提示词中移除多余的 @ 图片。</p>}
      <div className="free-credit-total"><span><Coins size={20} />本次预计消耗</span><strong>{quote.isFetching ? "计算中…" : quote.data ? `${creditText(quote.data.credits)} 积分` : "—"}</strong></div>{quote.error && <p className="error-banner">{errorText(quote.error)}</p>}{create.error && !confirming && <p className="error-banner">{errorText(create.error)}</p>}
      <button className="primary-button free-generate-button" type="button" disabled={!ready} onClick={() => { create.reset(); setConfirming(true); }}><Sparkles size={18} />生成视频</button>
    </section>
    <section className="free-task-area"><header><div><span className="section-label">TASK CENTER</span><h2>创作任务</h2><p>{taskRows.length} 个任务 · 可同时生成多个视频</p></div><div><button className="secondary-button" type="button" onClick={() => setShowCompose(true)}><Clapperboard size={16} />合成视频</button><span className="free-view-toggle"><button type="button" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} title="卡片视图"><Grid2X2 size={15} /></button><button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")} title="列表视图"><List size={16} /></button></span></div></header>
      {tasks.isLoading ? <div className="free-task-empty"><LoaderCircle className="spin" size={28} /><span>正在读取任务…</span></div> : tasks.error ? <p className="error-banner">{errorText(tasks.error)}</p> : !taskRows.length ? <div className="free-task-empty"><Clapperboard size={34} /><strong>还没有创作任务</strong><span>在左侧填写提示词并生成，第一个任务会显示在这里。</span></div> : <div className={`free-task-list ${view}`}>{taskRows.map((task) => <article key={task.id} className={`free-task-card ${task.record.status.toLowerCase()}`}><button className="free-task-media" type="button" disabled={task.record.status !== "COMPLETED"} onClick={() => setPreview(task)}><TaskVideo task={task} />{task.record.status === "COMPLETED" && <span><Play size={16} />预览</span>}</button><div className="free-task-copy"><header><strong>{task.kind === "composition" ? "合成视频" : task.prompt}</strong><em>{statusLabels[task.record.status]}</em></header><p>{task.record.model}{task.duration ? ` · ${task.duration} 秒` : ""}{task.resolution ? ` · ${task.resolution}` : ""} · {task.record.aspect_ratio}</p>{task.visual_style_name && <small>画风：{task.visual_style_name}</small>}{task.reference_names.length > 0 && <small>参考图：{task.reference_names.join("、")}</small>}{task.record.error?.message && <small className="error">{task.record.error.message}</small>}{taskSaveResult?.taskId === task.id && <small className={taskSaveResult.error ? "error" : "success"}>{taskSaveResult.message}</small>}<footer className="free-task-card-footer"><time>{new Date(task.record.created_at).toLocaleString("zh-CN")}</time>{task.record.status === "COMPLETED" && <button className="free-task-download" type="button" disabled={savingTaskId === task.id} onClick={() => void downloadTask(task)}>{savingTaskId === task.id ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}{savingTaskId === task.id ? "保存中…" : "下载"}</button>}</footer></div></article>)}</div>}
    </section>
    {confirming && quote.data && <ConfirmGenerationModal credits={quote.data.credits} balance={balance.data?.available} busy={create.isPending} error={create.error} onCancel={() => { if (!create.isPending) setConfirming(false); }} onConfirm={() => create.mutate()} />}
    {preview && workspace.data && <PreviewModal task={preview} workspace={workspace.data} onClose={() => setPreview(undefined)} />}
    {showCompose && workspace.data && <ComposeModal workspace={workspace.data} tasks={taskRows} onClose={() => setShowCompose(false)} />}
  </div>;
}
