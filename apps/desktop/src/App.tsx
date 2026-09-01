import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { WorkflowStartModal, type WorkflowStartChoice, type PlannedMedia } from "./components/WorkflowStartModal";
import { runningWorkflows, setWorkflowQuiet } from "./services/workflowQuiet";
import { mergeTaskSnapshots, workflowErrorMessage } from "./services/workflowState";
import {
  AlertTriangle, BookOpen, Boxes, Check, CheckCircle2, ChevronRight, CircleUserRound, Clapperboard, Coins, Copy, Download, FolderOpen,
  FileDown, FileText, History, Image as ImageIcon, Images, Lightbulb, Link2, LoaderCircle, Lock, LockOpen, Play, Plus, Rocket, RotateCcw, Save, ScanSearch, ScrollText, Settings, Sparkles, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import type { AgentClientAction, AiSettings, ApplicationLogEntry, ApplicationLogLevel, AssetLibraryItem, AutomaticWorkflowStage, AutomaticWorkflowTaskSnapshot, BrowserCookieSource, CanonicalProject, Character, CharacterState, CreativeTypePreset, CreateDouyinUnderstandingTaskInput, CreateImageGenerationTaskItem, CreateProjectInput, CreateShotVideoGenerationInput, CreationSpec, DouyinDownloadResult, DouyinUnderstandingTask, DouyinVideoInfo, Episode, GenerationRecord, GenerationReferenceAssetInput, IdeaDevelopmentAction, IdeaDevelopmentWorkflow, ImageGenerationTask, ProjectBundle, ProjectListItem, ProjectSourceType, Scene, Shot, VideoCreditResolution, VideoRemixOriginality, VideoRemixStoryboardDurationMode, VideoRemixTask } from "@aivs/schemas";
import { chooseCookieFile, chooseProjectDirectory, chooseProjectImage, chooseScriptFile, chooseVideoSavePath, composeProjectVideo, createAutomaticWorkflow, createDouyinUnderstandingTask, createImageGenerationTasks, createProject, createShotVideoGeneration, createVideoRemixProject, createVideoRemixTask, deleteAssetLibrary, deleteProject, deleteVideoRemixTask, deleteVideoUnderstandingTask, downloadDouyinVideo, downloadDouyinVideoAuto, exportAllGenerationAssets, getActiveAutomaticWorkflow, getAiSettings, getDouyinBrowserAvailability, getIdeaDevelopmentWorkflow, importProjectReferenceImage, listApplicationLogs, listAssetLibrary, listDouyinUnderstandingTasks, listGenerationRecords, listImageGenerationTasks, listLocalVideoUnderstandingTasks, listProjects, listVideoRemixTasks, loadProject, readProjectAsset, resolveDouyinAuto, resolveDouyinUrl, resumeImageGenerationTasks, retryDouyinUnderstandingTask, retryLocalVideoUnderstandingTask, retryVideoRemixTask, runInitialWorkflow, saveCanonical, saveGenerationRecordAsset, saveTextAsTxt, updateAutomaticWorkflow, updateIdeaDevelopmentWorkflow } from "./services/backend";
import { type WorkspacePage, useStudioStore } from "./store";
import { AssetLibraryPickerModal } from "./components/AssetLibraryPickerModal";
import { AiSettingsModal } from "./components/AiSettingsModal";
import { AccountCenterModal } from "./components/AccountCenterModal";
import { ModelCreditNotice } from "./components/CreditConfirmationHost";
import { AgentChatModal } from "./components/AgentChatModal";
import { VideoUnderstandingPanel } from "./components/VideoUnderstandingPanel";
import { VisualMentionEditor, type VisualMentionItem } from "./components/VisualMentionEditor";
import { activatePlatformUserContext, bindPlatformSessionUser, clearInvalidPlatformSession, getCreditBalance, getPlatformUser, listCreativeTypeCategories, listCreativeTypes, listMediaModels, listVisualStyleCategories, listVisualStyles, loadPlatformSession, platformApiBaseUrl, PlatformApiError, type PlatformMediaModel } from "./services/platform";
import { CHARACTER_IMAGE_PROMPT } from "./prompts/characterImage";
import { buildVideoUnderstandingPrompt, type FixedStoryboardSeconds, type StoryboardUnderstandingMode, type StoryboardUnderstandingSelection } from "./videoUnderstandingModes";
import { supportedLocales, useI18n, type AppLocale } from "./i18n";
import type { MessageKey } from "./i18n/locales";
import type { AutomaticWorkflowSnapshot } from "@aivs/schemas";

const defaultSpec: CreationSpec = {
  project_name: "齐天一小时", input_type: "IDEA", target_duration: 60, aspect_ratio: "9:16",
  content_type: "SHORT_DRAMA", visual_style: "", target_platform: "WECHAT_VIDEO_CHANNEL",
  language: "zh-CN", creation_mode: "DIRECTOR",
};

type CreateMode = Exclude<ProjectSourceType, "SCRIPT_TEXT"> | "DOUYIN_URL" | "VIDEO_UNDERSTANDING";
type CookieSource = BrowserCookieSource | "managed" | "file" | "";
type DouyinTaskReviewState = { script: string; spec: CreationSpec; rootPath: string };
type MediaModelSelection = { model: PlatformMediaModel; resolution: string; creditCost: number; workflowCreditId?: string };
const MEDIA_PICKER_EVENT = "aivs:pick-media-model";

function requestMediaModel(capability: PlatformMediaModel["capability"], title: string): Promise<MediaModelSelection> {
  return new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent(MEDIA_PICKER_EVENT, { detail: { capability, title, resolve, reject } })));
}

function mediaImageFields(selection: MediaModelSelection) {
  return { platform_api_base_url: platformApiBaseUrl, provider_model_id: selection.model.id, model_alias: selection.model.model_alias, resolution: selection.resolution, workflow_credit_id: selection.workflowCreditId };
}

function mediaVideoFields(selection: MediaModelSelection) {
  return { platform_api_base_url: platformApiBaseUrl, provider_model_id: selection.model.id, model_alias: selection.model.model_alias, resolution: selection.resolution, workflow_credit_id: selection.workflowCreditId };
}

function workflowMediaSnapshot(selections?: { image: MediaModelSelection; video: MediaModelSelection }): AutomaticWorkflowSnapshot {
  if (!selections) return {};
  const serialize = (selection: MediaModelSelection) => ({ provider_model_id: selection.model.id, model_alias: selection.model.model_alias, model_code: selection.model.model_code, resolution: selection.resolution, credit_cost: selection.creditCost, workflow_credit_id: selection.workflowCreditId });
  return { image_model: serialize(selections.image), video_model: serialize(selections.video) };
}

function restoredWorkflowMedia(snapshot: AutomaticWorkflowSnapshot): { image: MediaModelSelection; video: MediaModelSelection } | undefined {
  if (!snapshot.image_model || !snapshot.video_model) return undefined;
  const restore = (value: NonNullable<AutomaticWorkflowSnapshot["image_model"]>) => ({ model: { id: value.provider_model_id, model_alias: value.model_alias, model_code: value.model_code } as PlatformMediaModel, resolution: value.resolution, creditCost: value.credit_cost, workflowCreditId: value.workflow_credit_id });
  return { image: restore(snapshot.image_model), video: restore(snapshot.video_model) };
}

function MediaModelSelectionHost() {
  const [request, setRequest] = useState<{ capability: PlatformMediaModel["capability"]; title: string; resolve: (selection: MediaModelSelection) => void; reject: (reason: Error) => void }>();
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedResolution, setSelectedResolution] = useState("");
  useEffect(() => {
    const listener = (event: Event) => { const detail = (event as CustomEvent).detail; setSelectedModelId(""); setSelectedResolution(""); setRequest((current) => { current?.reject(new Error("已切换到新的模型选择请求")); return detail; }); };
    window.addEventListener(MEDIA_PICKER_EVENT, listener);
    return () => window.removeEventListener(MEDIA_PICKER_EVENT, listener);
  }, []);
  const models = useQuery({ queryKey: ["platform-media-models", request?.capability], queryFn: () => listMediaModels(request!.capability), enabled: Boolean(request), staleTime: 0 });
  if (!request) return null;
  const selectedModel = models.data?.find((model) => model.id === selectedModelId);
  const selectedPrice = selectedModel?.resolution_prices.find((price) => price.resolution === selectedResolution);
  const close = () => { setRequest(undefined); request.reject(new Error("已取消选择生成模型")); };
  const confirm = () => { if (!selectedModel || !selectedPrice) return; setRequest(undefined); request.resolve({ model: selectedModel, resolution: selectedPrice.resolution, creditCost: selectedPrice.credit_cost }); };
return <div className="modal-backdrop media-model-picker-backdrop"><section className="media-model-picker"><header><div><span className="section-label">选择生成方案</span><h2>{request.title}</h2><p>{request.capability === "VIDEO_GENERATION" ? "先选清晰度，按视频秒数计算积分。开始前会告诉你一共需要多少分。" : "先选清晰度，下方是每张图片需要的积分。开始前会告诉你一共需要多少分。"}</p></div><button type="button" onClick={close}><X size={18} /></button></header><div className="media-model-options">{models.isLoading ? <div className="media-model-empty"><LoaderCircle className="spin" />正在加载可选方案…</div> : models.error ? <div className="error-banner">暂时无法加载，请稍后再试：{readableError(models.error)}</div> : models.data?.length ? models.data.map((model) => <article className={selectedModelId === model.id ? "active" : ""} key={model.id}><button type="button" className="media-model-main" onClick={() => { setSelectedModelId(model.id); setSelectedResolution(model.resolution_prices[0]?.resolution || ""); }}><strong>{model.model_alias}</strong><small>{model.provider_name} · {model.display_name}</small>{model.generation_notice && <small>{model.generation_notice}</small>}</button><div className="media-resolution-list">{model.resolution_prices.map((price) => <label key={price.resolution}><input type="radio" name="media-resolution" checked={selectedModelId === model.id && selectedResolution === price.resolution} onChange={() => { setSelectedModelId(model.id); setSelectedResolution(price.resolution); }} /><span>{price.label || price.resolution}</span><em>{price.credit_cost} 积分{request.capability === "VIDEO_GENERATION" ? "/秒" : "/张"}</em></label>)}</div></article>) : <div className="media-model-empty">暂时没有可用的生成方案，请稍后再试或联系客服。</div>}</div><footer><button className="secondary-button" type="button" onClick={close}>取消</button><button className="primary-button" type="button" onClick={confirm} disabled={!selectedPrice}>确认使用</button></footer></section></div>;
}

function readableError(error: unknown): string {
  return workflowErrorMessage(error);
}

function errorTextFragments(error: unknown, seen = new Set<object>(), depth = 0): string[] {
  if (error == null || depth > 5) return [];
  if (typeof error === "string") {
    const value = error.trim();
    if (!value) return [];
    try {
      return [value, ...errorTextFragments(JSON.parse(value), seen, depth + 1)];
    } catch {
      return [value];
    }
  }
  if (typeof error === "number" || typeof error === "boolean") return [String(error)];
  if (typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  if (error instanceof Error) return [error.message, ...errorTextFragments(error.cause, seen, depth + 1)].filter(Boolean);
  if (Array.isArray(error)) return error.flatMap((item) => errorTextFragments(item, seen, depth + 1));
  return Object.values(error).flatMap((value) => errorTextFragments(value, seen, depth + 1));
}

function isInsufficientBalanceError(error: unknown): boolean {
  const text = errorTextFragments(error).join("\n");
  return [
    /(?:账户|账号|可用)?余额(?:不足|不够|已用完|已耗尽|为\s*0)/i,
    /(?:积分|点数|额度|配额|算力|金币)(?:不足|不够|已用完|已耗尽|为\s*0)/i,
    /账户欠费|账号欠费|充值后重试/i,
    /insufficient[\s_-]+(?:account[\s_-]+)?(?:balance|credit|credits|funds|quota)/i,
    /(?:balance|credit|credits|quota)[\s_-]+(?:is[\s_-]+)?(?:insufficient|exhausted|depleted)/i,
    /(?:out[\s_-]+of|no)[\s_-]+(?:credit|credits|quota)/i,
  ].some((pattern) => pattern.test(text));
}

function insufficientBalanceReason(error: unknown): string {
  const matching = errorTextFragments(error).filter((fragment) => isInsufficientBalanceError(fragment));
  return matching.sort((left, right) => left.length - right.length)[0] || readableError(error);
}

function workflowSummaryText(value: unknown, fallback?: unknown): string {
  const normalize = (candidate: unknown): string => {
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
    if (Array.isArray(candidate)) return candidate.map(normalize).filter(Boolean).join("\n");
    if (candidate && typeof candidate === "object") {
      const object = candidate as Record<string, unknown>;
      const content = object.text ?? object.dialogue ?? object.content ?? object.description;
      if (typeof content === "string") {
        const speaker = object.character_name ?? object.character_id ?? object.speaker;
        return typeof speaker === "string" && speaker.trim() ? `${speaker.trim()}：${content}` : content;
      }
      const summary = object.summary;
      if (typeof summary === "string") return summary;
      const title = object.title;
      if (typeof title === "string") return title;
    }
    return "";
  };
  return normalize(value) || normalize(fallback);
}

function runtimeTextList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => workflowSummaryText(item)).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n|[；;]/).map((item) => item.replace(/^\s*[-*•\d.、]+\s*/, "").trim()).filter(Boolean);
  const text = workflowSummaryText(value);
  return text ? [text] : [];
}

function videoFilename(info: DouyinVideoInfo): string {
  const name = (info.title || info.id || "短视频").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80);
  return `${name || "短视频"}.mp4`;
}

function storyboardTheme(script: string): string {
  const patterns = [
    /(?:^|\n)\s*(?:【主题】|主题)\s*[：:]\s*([^\n]+)/m,
    /(?:^|\n)\s*[#*\-\d.、 ]*主题\s*[：:]\s*([^\n]+)/m,
  ];
  for (const pattern of patterns) {
    const value = script.match(pattern)?.[1]?.replace(/[【】*_#]/g, "").trim();
    if (value) return value.slice(0, 60);
  }
  return "";
}

function videoAspectRatio(info?: Pick<DouyinVideoInfo, "width" | "height">): "9:16" | "16:9" | undefined {
  if (!info?.width || !info.height) return undefined;
  return info.width > info.height ? "16:9" : "9:16";
}

function videoPlatformLabel(platform?: DouyinVideoInfo["platform"]): string {
  if (platform === "DOUYIN") return "抖音";
  if (platform === "KUAISHOU") return "快手";
  if (platform === "BILIBILI") return "哔哩哔哩";
  return "待识别平台";
}

function storyboardAspectRatio(script: string): "9:16" | "16:9" | undefined {
  const value = script.match(/(?:^|\n)\s*屏幕比例\s*[：:]\s*(9:16|16:9)/m)?.[1];
  return value === "16:9" ? "16:9" : value === "9:16" ? "9:16" : undefined;
}

function storyboardTotalDuration(script: string): number | undefined {
  const ranges = [...script.matchAll(/第\s*\d+\s*段\s*[（(]\s*\d+(?:\.\d+)?\s*(?:～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒?\s*[）)]/g)];
  const duration = ranges.reduce((maximum, match) => Math.max(maximum, Number(match[1]) || 0), 0);
  return duration > 0 ? duration : undefined;
}

function normalizeStoryboardAspectRatio(script: string, aspectRatio: "9:16" | "16:9"): string {
  return script.replace(/^(\s*屏幕比例\s*[：:]\s*)(?:9:16|16:9)(?:[^\r\n]*)$/gm, `$1${aspectRatio}`);
}

function formatStoryboardSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeDetailedStoryboardLocalTimelines(script: string): string {
  const headerPattern = /^\s*第\s*\d+\s*段\s*[（(]\s*(\d+(?:\.\d+)?)\s*(?:～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒?\s*[）)]\s*$/gm;
  const headers = [...script.matchAll(headerPattern)];
  let normalized = script;
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const header = headers[index]!;
    const sourceStart = Number(header[1]);
    if (!(sourceStart > 0) || header.index == null) continue;
    const bodyStart = header.index + header[0].length;
    const bodyEnd = index + 1 < headers.length ? headers[index + 1]!.index! : normalized.length;
    const body = normalized.slice(bodyStart, bodyEnd);
    const visualPattern = /(^\s*画面\s*[：:]\s*)([\s\S]*?)(?=^\s*口播台词\s*[：:])/m;
    const visualMatch = body.match(visualPattern);
    if (!visualMatch) continue;
    const visual = visualMatch[2] ?? "";
    const ranges = [...visual.matchAll(/(\d+(?:\.\d+)?)\s*(～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒/g)];
    if (!ranges.length || Math.min(...ranges.map((range) => Number(range[1]))) < sourceStart - 0.001) continue;
    const localizedVisual = visual.replace(/(\d+(?:\.\d+)?)\s*(～|~|-|—|至)\s*(\d+(?:\.\d+)?)\s*秒/g, (_value, start, separator, end) => `${formatStoryboardSeconds(Math.max(0, Number(start) - sourceStart))}${separator}${formatStoryboardSeconds(Math.max(0, Number(end) - sourceStart))}秒`);
    const localizedBody = body.replace(visualPattern, (_matched, heading: string) => `${heading}${localizedVisual}`);
    normalized = `${normalized.slice(0, bodyStart)}${localizedBody}${normalized.slice(bodyEnd)}`;
  }
  return normalized;
}

function GroupedVisualStyleSelect({ value, onChange, presets, categories, automaticLabel = "由AI生成画风" }: { value: string; onChange: (value: string) => void; presets: import("@aivs/schemas").VisualStylePreset[]; categories?: string[]; automaticLabel?: string }) {
  const selectedPreset = presets.find((preset) => preset.prompt === value);
  const hasPreset = Boolean(selectedPreset);
  const categoryNames = categories?.length ? categories : Array.from(new Set(presets.map((preset) => preset.category)));
  return <label className="grouped-visual-style-select">画风设定<select value={hasPreset || !value ? value : "__current__"} onChange={(event) => { if (event.target.value !== "__current__") onChange(event.target.value); }}><option value="">{automaticLabel}</option>{value && !hasPreset && <option value="__current__">当前自定义画风</option>}{categoryNames.flatMap((category) => [<option disabled value={`__category_${category}`} key={`category-${category}`}>{category}</option>, ...presets.filter((preset) => preset.category === category).map((preset) => <option value={preset.prompt} key={preset.id}>　　{preset.name}</option>)])}</select></label>;
}

const navItems: Array<[WorkspacePage, MessageKey, typeof BookOpen]> = [
  ["story", "story", BookOpen], ["scenes", "scenes", Boxes], ["characters", "characters", CircleUserRound],
  ["storyboard", "storyboard", Clapperboard],
];

function AccountIdentity({ onOpenAccount }: { onOpenAccount: () => void }) {
  const session = useQuery({ queryKey: ["platform-session"], queryFn: loadPlatformSession, staleTime: Infinity });
  const loggedIn = Boolean(session.data);
  const user = useQuery({ queryKey: ["platform-user"], queryFn: getPlatformUser, enabled: loggedIn, retry: false });
  const balance = useQuery({ queryKey: ["credit-balance"], queryFn: getCreditBalance, enabled: loggedIn, retry: false, refetchInterval: 15_000 });
  const name = user.data?.display_name?.trim() || user.data?.email || user.data?.phone || "平台用户";
  const detail = user.data?.email || user.data?.phone || "微信账户";
  const currentCredits = balance.data?.balance ?? user.data?.credit_balance;
  return <button className="account-identity" type="button" onClick={onOpenAccount} aria-label={loggedIn ? "打开用户信息" : "用户注册登录"}>
    <span className="account-identity-avatar">{session.isLoading || user.isLoading ? <LoaderCircle className="spin" size={17} /> : loggedIn ? name.slice(0, 1).toUpperCase() : <CircleUserRound size={19} />}</span>
    <span className="account-identity-copy"><strong>{session.isLoading ? "读取登录状态…" : loggedIn ? name : "登录 / 注册"}</strong><small className={loggedIn ? "account-identity-detail" : undefined}>{loggedIn ? <><b>{currentCredits === undefined ? "积分 —" : `积分 ${Number(currentCredits).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}`}</b><span>{detail}</span></> : "登录后使用模型与积分"}</small></span>
    <ChevronRight className="account-identity-arrow" size={15} />
  </button>;
}

function AccountEntry() {
  const [open, setOpen] = useState(false);
  return <>
    <AccountIdentity onOpenAccount={() => setOpen(true)} />
    {open && createPortal(<AccountCenterModal onClose={() => setOpen(false)} />, document.body)}
  </>;
}

export function App() {
  const { t } = useI18n();
  const { bundle, page, dirty, setBundle, setPage, markSaved, setPendingAgentProduction } = useStudioStore();
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showGenerationRecords, setShowGenerationRecords] = useState(false);
  const [showApplicationLogs, setShowApplicationLogs] = useState(false);
  const [showAgentChat, setShowAgentChat] = useState(false);
  const queryClient = useQueryClient();
  const platformSession = useQuery({ queryKey: ["platform-session"], queryFn: loadPlatformSession, staleTime: Infinity });
  const platformUser = useQuery({ queryKey: ["platform-user"], queryFn: getPlatformUser, enabled: Boolean(platformSession.data), retry: false });
  const authenticated = Boolean(platformSession.data?.user_id && platformSession.data.user_id === platformUser.data?.id);
  const activeUserId = useRef<string | null>(null);
  useEffect(() => {
    const userId = platformUser.data?.id;
    if (!userId || platformSession.data?.user_id === userId) return;
    void bindPlatformSessionUser(userId).then(() => {
      queryClient.setQueryData(["platform-session"], { ...platformSession.data!, user_id: userId });
    });
  }, [platformSession.data, platformUser.data, queryClient]);
  useEffect(() => {
    if (authenticated) void activatePlatformUserContext();
  }, [authenticated, platformUser.data?.id]);
  useEffect(() => {
    const userId = platformUser.data?.id;
    if (!userId) return;
    if (activeUserId.current && activeUserId.current !== userId) {
      setBundle(undefined);
      queryClient.removeQueries({ predicate: (query) => !["platform-session", "platform-user"].includes(String(query.queryKey[0])) });
    }
    activeUserId.current = userId;
  }, [platformUser.data?.id, queryClient, setBundle]);
  useEffect(() => {
    if (!(platformUser.error instanceof PlatformApiError) || platformUser.error.status !== 401) return;
    void clearInvalidPlatformSession().finally(() => {
      queryClient.setQueryData(["platform-session"], null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "platform-session" });
      setBundle(undefined);
    });
  }, [platformUser.error, queryClient, setBundle]);
  const handleAgentProjectAction = async (action: AgentClientAction) => {
    const opened = await loadProject(action.project_path);
    if (action.type === "open_project_and_start_production" && (action.production_mode === "fast" || action.production_mode === "storyboard")) {
      setPendingAgentProduction({ project_id: action.project_id, mode: action.production_mode, resolution: action.resolution || "720p" });
    }
    setBundle(opened);
    setShowAgentChat(false);
  };
  const save = useMutation({
    mutationFn: () => saveCanonical(bundle!),
    onSuccess: (result) => { setBundle(result); markSaved(); },
  });
  const startupWorkflowRecovery = useQuery({
    queryKey: ["startup-active-automatic-workflow"],
    queryFn: async (): Promise<ProjectBundle | null> => {
      const projects = await listProjects();
      for (const project of projects) {
        try {
          const active = await getActiveAutomaticWorkflow(project.project_path, project.id);
          if (active) return loadProject(project.project_path);
          const ideaWorkflow = await getIdeaDevelopmentWorkflow(project.project_path, project.id);
          if (ideaWorkflow && !["COMPLETED", "CANCELLED"].includes(ideaWorkflow.status)) return loadProject(project.project_path);
        } catch {
          // A damaged or unavailable project must not prevent the app from starting.
        }
      }
      return null;
    },
    staleTime: Infinity,
    enabled: authenticated,
  });
  const startupWorkflowHandled = useRef(false);
  useEffect(() => {
    if (startupWorkflowHandled.current || startupWorkflowRecovery.isLoading) return;
    startupWorkflowHandled.current = true;
    if (!bundle && startupWorkflowRecovery.data) setBundle(startupWorkflowRecovery.data);
  }, [bundle, setBundle, startupWorkflowRecovery.data, startupWorkflowRecovery.isLoading]);

  if (platformSession.isLoading || (platformSession.data && platformUser.isLoading) || (platformUser.data && !authenticated)) return <div className="account-auth-gate"><LoaderCircle className="spin" size={28} /><span>正在验证登录状态…</span></div>;
  if (!authenticated) return <AccountCenterModal required onClose={() => undefined} />;
  if (!bundle?.canonical) return <><CreateProjectScreen initialBundle={bundle} onReady={setBundle} onOpenAgent={() => setShowAgentChat(true)} onOpenSettings={() => setShowAiSettings(true)} onOpenLogs={() => setShowApplicationLogs(true)} />{showAiSettings && <AiSettingsModal onClose={() => setShowAiSettings(false)} />}{showApplicationLogs && <ApplicationLogsModal onClose={() => setShowApplicationLogs(false)} />}{showAgentChat && <AgentChatModal onClose={() => setShowAgentChat(false)} onProjectAction={handleAgentProjectAction} />}</>;

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <AccountEntry />
        <div className="project-chip"><div className="project-avatar">{bundle.project.name.slice(0, 1)}</div><div><strong>{bundle.project.name}</strong><span>{bundle.canonical.story.aspect_ratio ?? bundle.creation_spec.aspect_ratio} · {bundle.creation_spec.target_duration}s</span></div></div>
        <nav className="workspace-nav">
          {navItems.map(([id, labelKey, Icon]) => (
            <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
              <Icon size={18} /><span>{t(labelKey)}</span>
              {page === id && <ChevronRight size={15} className="nav-arrow" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer"><span className="status-dot" /> Local-first · V0.1</div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="top-actions">
            <span className={dirty ? "save-state dirty" : "save-state"}>{dirty ? t("unsaved") : t("savedLocally")}</span>
            <button className="secondary-button toolbar-button" onClick={() => setShowAiSettings(true)}><Settings size={15} /> {t("systemSettings")}</button>
            <button className="secondary-button toolbar-button" onClick={() => setShowGenerationRecords(true)}><History size={15} /> 生成记录</button>
            <button className="secondary-button toolbar-button" onClick={() => setShowApplicationLogs(true)}><ScrollText size={15} /> 日志</button>
            <button className="secondary-button toolbar-button" onClick={() => { if (!dirty || window.confirm("当前更改尚未保存，仍要返回首页吗？")) setBundle(undefined); }}><FolderOpen size={15} /> 返回首页</button>
            <button className="secondary-button toolbar-button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} {t("save")}
            </button>
          </div>
        </header>
        <div className="page-content">
          {page === "story" && <StoryPage canonical={bundle.canonical} projectPath={bundle.project.project_path} projectId={bundle.project.id} />}
          {page === "characters" && <CharactersPage canonical={bundle.canonical} projectPath={bundle.project.project_path} projectId={bundle.project.id} />}
          {page === "scenes" && <ScenesPage canonical={bundle.canonical} projectPath={bundle.project.project_path} projectId={bundle.project.id} />}
          {page === "storyboard" && <StoryboardPage canonical={bundle.canonical} projectPath={bundle.project.project_path} projectId={bundle.project.id} />}
          {page === "jobs" && <JobsPage bundle={bundle} />}
        </div>
      </main>
      {showAiSettings && <AiSettingsModal onClose={() => setShowAiSettings(false)} />}
      {showGenerationRecords && <GenerationRecordsModal projectPath={bundle.project.project_path} onClose={() => setShowGenerationRecords(false)} />}
      {showApplicationLogs && <ApplicationLogsModal onClose={() => setShowApplicationLogs(false)} />}
      {showAgentChat && <AgentChatModal onClose={() => setShowAgentChat(false)} onProjectAction={handleAgentProjectAction} />}
      <MediaModelSelectionHost />
    </div>
  );
}

function CreateProjectScreen({ initialBundle, onReady, onOpenSettings, onOpenLogs }: { initialBundle?: ProjectBundle; onReady: (bundle: ProjectBundle) => void; onOpenAgent: () => void; onOpenSettings: () => void; onOpenLogs: () => void }) {
  const { t } = useI18n();
  const [spec, setSpec] = useState(defaultSpec);
  const [sourceType, setSourceType] = useState<CreateMode>(() => initialBundle?.source_type === "IDEA" && !initialBundle.canonical ? "IDEA" : "DOUYIN_URL");
  const [sourceText, setSourceText] = useState(() => initialBundle?.source_type === "IDEA" && !initialBundle.canonical ? initialBundle.source_text || "一个外卖员获得孙悟空能力，每天只能变身一个小时。" : "");
  const [sourcePath, setSourcePath] = useState("");
  const [rootPath, setRootPath] = useState("C:\\AI Video Studio Projects");
  const [cookieSource, setCookieSource] = useState<CookieSource>("managed");
  const [cookieFilePath, setCookieFilePath] = useState("");
  const [showProjectCenter, setShowProjectCenter] = useState(false);
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);
  const [projectPendingDelete, setProjectPendingDelete] = useState<ProjectListItem>();
  const [showCreativeTypeSelector, setShowCreativeTypeSelector] = useState(false);
  const [showStoryboardMode, setShowStoryboardMode] = useState(false);
  const [videoUnderstandingModeHandler, setVideoUnderstandingModeHandler] = useState<((selection: StoryboardUnderstandingSelection) => void) | null>(null);
  const [localVideoTaskReviews, setLocalVideoTaskReviews] = useState<Record<string, DouyinTaskReviewState>>({});
  const [douyinTaskReviews, setDouyinTaskReviews] = useState<Record<string, DouyinTaskReviewState>>({});
  const [creatingDouyinTaskId, setCreatingDouyinTaskId] = useState<string>();
  const [ideaWorkflowBundle, setIdeaWorkflowBundle] = useState<ProjectBundle | undefined>(
    initialBundle?.source_type === "IDEA" && !initialBundle.canonical ? initialBundle : undefined,
  );
  const [showIdeaWorkflow, setShowIdeaWorkflow] = useState(Boolean(initialBundle?.source_type === "IDEA" && !initialBundle.canonical));
  useEffect(() => {
    if (initialBundle?.source_type !== "IDEA" || initialBundle.canonical) return;
    setIdeaWorkflowBundle(initialBundle);
    setShowIdeaWorkflow(true);
  }, [initialBundle]);
  const create = useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const skeleton = await createProject(input);
      if (skeleton.source_type === "IDEA") {
        setIdeaWorkflowBundle(skeleton);
        setShowIdeaWorkflow(true);
      }
      return runInitialWorkflow(skeleton);
    },
    onSuccess: (bundle) => {
      if (bundle.source_type === "IDEA" && !bundle.canonical) {
        setIdeaWorkflowBundle(bundle);
        setShowIdeaWorkflow(true);
        return;
      }
      setIdeaWorkflowBundle(undefined);
      setShowIdeaWorkflow(false);
      onReady(bundle);
    },
  });
  const ideaWorkflow = useQuery({
    queryKey: ["idea-development-workflow", ideaWorkflowBundle?.project.project_path, ideaWorkflowBundle?.project.id],
    queryFn: () => getIdeaDevelopmentWorkflow(ideaWorkflowBundle!.project.project_path, ideaWorkflowBundle!.project.id),
    enabled: Boolean(ideaWorkflowBundle),
    refetchInterval: ideaWorkflowBundle ? 1_000 : false,
  });
  const ideaWorkflowAction = useMutation({
    mutationFn: ({ action, payload }: { action: IdeaDevelopmentAction; payload?: Record<string, unknown> }) => updateIdeaDevelopmentWorkflow({
      project_path: ideaWorkflowBundle!.project.project_path,
      project_id: ideaWorkflowBundle!.project.id,
      workflow_id: ideaWorkflow.data!.id,
      action,
      payload,
    }),
    onSuccess: async (workflow) => {
      await ideaWorkflow.refetch();
      if (workflow.status === "CANCELLED") {
        setShowIdeaWorkflow(false);
        return;
      }
      if (workflow.status === "COMPLETED" && ideaWorkflowBundle) {
        const completed = await loadProject(ideaWorkflowBundle.project.project_path);
        setIdeaWorkflowBundle(undefined);
        setShowIdeaWorkflow(false);
        onReady(completed);
      }
    },
  });
  const openProject = useMutation({
    mutationFn: (project: ProjectListItem) => loadProject(project.project_path),
    onSuccess: onReady,
  });
  const projectList = useMutation({ mutationFn: listProjects });
  const assetLibrary = useQuery({ queryKey: ["asset-library"], queryFn: listAssetLibrary, enabled: showAssetLibrary });
  const deleteLocalProject = useMutation({
    mutationFn: (project: ProjectListItem) => deleteProject(project.id),
    onSuccess: () => {
      setProjectPendingDelete(undefined);
      projectList.mutate();
      void assetLibrary.refetch();
    },
  });
  const browserAvailability = useQuery({ queryKey: ["douyin-browser-availability"], queryFn: getDouyinBrowserAvailability, staleTime: 30_000 });
  const localAiSettings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const visualStyleCategories = useQuery({ queryKey: ["visual-style-categories"], queryFn: listVisualStyleCategories, staleTime: 60_000 });
  const visualStyles = useQuery({ queryKey: ["visual-styles"], queryFn: listVisualStyles, staleTime: 60_000 });
  const creativeTypeCategories = useQuery({ queryKey: ["creative-type-categories"], queryFn: listCreativeTypeCategories, staleTime: 60_000 });
  const creativeTypeCatalog = useQuery({ queryKey: ["creative-types"], queryFn: listCreativeTypes, staleTime: 60_000 });
  const aiSettings = {
    ...localAiSettings,
    isLoading: localAiSettings.isLoading || visualStyles.isLoading || creativeTypeCatalog.isLoading,
    data: localAiSettings.data ? { ...localAiSettings.data, visual_style_presets: visualStyles.data ?? [], creative_type_presets: creativeTypeCatalog.data ?? [] } : undefined,
  };
  const creativeTypes = useMemo(() => {
    const order = new Map((creativeTypeCategories.data ?? []).map((item, index) => [item.name, index]));
    return [...(creativeTypeCatalog.data ?? [])].sort((left, right) => (order.get(left.category) ?? 999) - (order.get(right.category) ?? 999));
  }, [creativeTypeCatalog.data, creativeTypeCategories.data]);
  const selectedCreativeType = creativeTypes.find((item) => item.id === spec.creative_type_id);
  useEffect(() => {
    if (sourceType !== "IDEA" || spec.visual_style) return;
    const cinematicRealism = visualStyles.data?.find((item) => item.id === "cinematic-realism" || item.name === "电影写实");
    if (cinematicRealism) setSpec((current) => current.visual_style ? current : { ...current, visual_style: cinematicRealism.prompt });
  }, [sourceType, spec.visual_style, visualStyles.data]);
  const douyin = useMutation({
    mutationFn: ({ shareText, managed, browserCookieSource, cookieFilePath: selectedCookieFile }: { shareText: string; managed?: boolean; browserCookieSource?: BrowserCookieSource; cookieFilePath?: string }) => managed ? resolveDouyinAuto(shareText) : resolveDouyinUrl(shareText, browserCookieSource, selectedCookieFile),
    onSuccess: (info) => {
      const aspectRatio = videoAspectRatio(info);
      if (aspectRatio) setSpec((current) => ({ ...current, aspect_ratio: aspectRatio }));
    },
  });
  const download = useMutation({
    mutationFn: ({ shareText, outputPath, managed, browserCookieSource, cookieFilePath: selectedCookieFile }: { shareText: string; outputPath: string; managed?: boolean; browserCookieSource?: BrowserCookieSource; cookieFilePath?: string }) => managed ? downloadDouyinVideoAuto(shareText, outputPath) : downloadDouyinVideo(shareText, outputPath, browserCookieSource, selectedCookieFile),
  });
  const douyinTasks = useQuery({
    queryKey: ["douyin-understanding-tasks"],
    queryFn: listDouyinUnderstandingTasks,
    enabled: sourceType === "DOUYIN_URL",
    refetchInterval: sourceType === "DOUYIN_URL" ? 1_200 : false,
  });
  const localVideoTasks = useQuery({
    queryKey: ["local-video-understanding-tasks"],
    queryFn: listLocalVideoUnderstandingTasks,
    enabled: sourceType === "VIDEO_UNDERSTANDING",
    refetchInterval: sourceType === "VIDEO_UNDERSTANDING" ? 1_200 : false,
  });
  const douyinStoryboard = useMutation({
    mutationFn: (selection: StoryboardUnderstandingSelection) => {
      const aspectRatio = videoAspectRatio(douyin.data);
      if (!douyin.data) throw new Error("请先解析视频链接");
      const input: CreateDouyinUnderstandingTaskInput = {
        share_text: sourceText.trim(),
        prompt: buildVideoUnderstandingPrompt(selection, aiSettings.data?.video_storyboard_prompt, aiSettings.data?.video_storyboard_detailed_prompt),
        source_width: douyin.data?.width,
        source_height: douyin.data?.height,
        aspect_ratio: aspectRatio,
        managed: cookieSource === "managed",
        browser_cookie_source: cookieSource && cookieSource !== "file" && cookieSource !== "managed" ? cookieSource : undefined,
        cookie_file_path: cookieSource === "file" ? cookieFilePath : undefined,
        video_info: douyin.data,
        mode: selection.mode,
        fixed_seconds: selection.fixedSeconds,
      };
      return createDouyinUnderstandingTask(input);
    },
    onSuccess: async () => {
      setSourceText("");
      douyin.reset();
      download.reset();
      await douyinTasks.refetch();
    },
  });
  const retryDouyinTask = useMutation({
    mutationFn: retryDouyinUnderstandingTask,
    onSuccess: () => douyinTasks.refetch(),
  });
  const retryLocalVideoTask = useMutation({
    mutationFn: retryLocalVideoUnderstandingTask,
    onSuccess: () => localVideoTasks.refetch(),
  });
  const deleteUnderstandingTask = useMutation({
    mutationFn: deleteVideoUnderstandingTask,
    onSuccess: async (_, taskId) => {
      setDouyinTaskReviews((reviews) => { const next = { ...reviews }; delete next[taskId]; return next; });
      setLocalVideoTaskReviews((reviews) => { const next = { ...reviews }; delete next[taskId]; return next; });
      await Promise.all([douyinTasks.refetch(), localVideoTasks.refetch()]);
    },
  });
  const confirmDeleteUnderstandingTask = (taskId: string) => {
    if (window.confirm("确定删除这条视频解析/理解记录吗？该记录下的所有二创记录也会一并删除，且无法恢复。")) {
      deleteUnderstandingTask.mutate(taskId);
    }
  };
  const openDouyinTaskResult = (task: DouyinUnderstandingTask) => {
    if (!task.result?.text) return;
    setDouyinTaskReviews((reviews) => {
      if (reviews[task.id]) return reviews;
      const locallyTimedStoryboard = task.mode === "detailed"
        ? normalizeDetailedStoryboardLocalTimelines(task.result!.text)
        : task.result!.text;
      const aspectRatio = task.aspect_ratio || storyboardAspectRatio(locallyTimedStoryboard);
      const storyboard = aspectRatio ? normalizeStoryboardAspectRatio(locallyTimedStoryboard, aspectRatio) : locallyTimedStoryboard;
      return { ...reviews, [task.id]: {
        script: storyboard,
        rootPath,
        spec: {
          ...spec,
          project_name: storyboardTheme(storyboard) || (task.title || "视频分镜项目").trim().slice(0, 60),
          target_duration: task.duration ? Math.max(5, Math.min(3600, Math.round(task.duration))) : spec.target_duration,
          aspect_ratio: aspectRatio || spec.aspect_ratio,
          input_type: "SCRIPT",
        },
      } };
    });
  };

  const selectSourceType = (value: CreateMode) => {
    setShowProjectCenter(false);
    setShowAssetLibrary(false);
    setSourceType(value);
    setSourcePath("");
    setSourceText(value === "IDEA" ? "一个外卖员获得孙悟空能力，每天只能变身一个小时。" : "");
    douyin.reset();
    download.reset();
    douyinStoryboard.reset();
    setShowStoryboardMode(false);
    setVideoUnderstandingModeHandler(null);
    setSpec((current) => ({
      ...current,
      input_type: value === "IDEA" ? "IDEA" : value === "DOUYIN_URL" || value === "VIDEO_UNDERSTANDING" ? "VIDEO" : "SCRIPT",
      project_name: value === "IDEA" ? defaultSpec.project_name : "",
      visual_style: value === "DOUYIN_URL" || value === "VIDEO_UNDERSTANDING" ? "" : current.visual_style || defaultSpec.visual_style,
    }));
  };
  const openProjectCenter = () => {
    setShowProjectCenter(true);
    setShowAssetLibrary(false);
    projectList.mutate();
  };
  const openAssetLibrary = () => {
    setShowProjectCenter(false);
    setShowAssetLibrary(true);
  };
  const selectRoot = async () => {
    const selected = await chooseProjectDirectory();
    if (selected) setRootPath(selected);
  };
  const selectScript = async () => {
    const selected = await chooseScriptFile();
    if (selected) setSourcePath(selected);
  };
  const selectCookieFile = async () => {
    const selected = await chooseCookieFile();
    if (selected) {
      setCookieFilePath(selected);
      douyin.reset();
      download.reset();
      douyinStoryboard.reset();
    }
  };
  const isSourceValid = sourceType === "SCRIPT_FILE" ? Boolean(sourcePath) : sourceText.trim().length >= (sourceType === "IDEA" ? 4 : 10);
  const autoLoginUnavailable = browserAvailability.data?.can_auto_login === false;
  const isCookieReady = cookieSource !== "file" || Boolean(cookieFilePath);
  const submit = () => {
    const input: CreateProjectInput = {
      root_path: rootPath,
      source_type: sourceType as ProjectSourceType,
      source_text: sourceType === "SCRIPT_FILE" ? undefined : sourceText,
      source_path: sourceType === "SCRIPT_FILE" ? sourcePath : undefined,
      creation_spec: sourceType === "IDEA" && selectedCreativeType ? {
        ...spec,
        creative_type_name: selectedCreativeType.name,
        creative_type_category: selectedCreativeType.category,
        creative_type_prompt: selectedCreativeType.prompt,
      } : spec,
    };
    setCreatingDouyinTaskId(undefined);
    create.reset();
    create.mutate(input);
  };
  const startDownload = async (info: DouyinVideoInfo) => {
    const outputPath = await chooseVideoSavePath(videoFilename(info));
    if (!outputPath) return;
    download.mutate({
      shareText: sourceText.trim(),
      outputPath,
      managed: cookieSource === "managed",
      browserCookieSource: cookieSource && cookieSource !== "file" && cookieSource !== "managed" ? cookieSource : undefined,
      cookieFilePath: cookieSource === "file" ? cookieFilePath : undefined,
    });
  };
  const updateDouyinTaskReview = (taskId: string, patch: Partial<DouyinTaskReviewState>) => setDouyinTaskReviews((reviews) => reviews[taskId] ? { ...reviews, [taskId]: { ...reviews[taskId], ...patch } } : reviews);
  const selectDouyinTaskRoot = async (taskId: string) => {
    const selected = await chooseProjectDirectory();
    if (selected) updateDouyinTaskReview(taskId, { rootPath: selected });
  };
  const localVideoReviewFromTask = (task: DouyinUnderstandingTask): DouyinTaskReviewState | undefined => {
    if (!task.result?.text) return undefined;
    const locallyTimedStoryboard = task.mode === "detailed" ? normalizeDetailedStoryboardLocalTimelines(task.result.text) : task.result.text;
    const aspectRatio = task.aspect_ratio || storyboardAspectRatio(locallyTimedStoryboard) || (spec.aspect_ratio === "16:9" ? "16:9" : "9:16");
    const duration = task.duration ?? storyboardTotalDuration(locallyTimedStoryboard) ?? spec.target_duration;
    return {
      script: normalizeStoryboardAspectRatio(locallyTimedStoryboard, aspectRatio),
      rootPath,
      spec: {
        ...spec,
        project_name: storyboardTheme(locallyTimedStoryboard) || (task.title || "本地视频分镜项目").trim().slice(0, 60),
        target_duration: duration,
        aspect_ratio: aspectRatio,
        input_type: "SCRIPT",
        visual_style: "",
      },
    };
  };
  const openLocalVideoTaskResult = (task: DouyinUnderstandingTask) => {
    setLocalVideoTaskReviews((reviews) => {
      if (reviews[task.id]) return reviews;
      const review = localVideoReviewFromTask(task);
      return review ? { ...reviews, [task.id]: review } : reviews;
    });
  };
  const updateLocalVideoTaskReview = (taskId: string, patch: Partial<DouyinTaskReviewState>) => setLocalVideoTaskReviews((reviews) => reviews[taskId] ? { ...reviews, [taskId]: { ...reviews[taskId], ...patch } } : reviews);
  const selectLocalVideoRoot = async (taskId: string) => {
    const selected = await chooseProjectDirectory();
    if (selected) updateLocalVideoTaskReview(taskId, { rootPath: selected });
  };
  const submitLocalVideoProject = (taskId: string) => {
    const review = localVideoTaskReviews[taskId];
    if (!review) return;
    setCreatingDouyinTaskId(taskId);
    create.reset();
    create.mutate({
      root_path: review.rootPath,
      source_type: "SCRIPT_TEXT",
      source_text: normalizeStoryboardAspectRatio(review.script, review.spec.aspect_ratio === "16:9" ? "16:9" : "9:16"),
      creation_spec: { ...review.spec, project_name: storyboardTheme(review.script) || review.spec.project_name, input_type: "SCRIPT" },
    });
  };
  const submitStoryboardProject = (taskId: string) => {
    const review = douyinTaskReviews[taskId];
    if (!review) return;
    setCreatingDouyinTaskId(taskId);
    create.reset();
    create.mutate({
      root_path: review.rootPath,
      source_type: "SCRIPT_TEXT",
      source_text: normalizeStoryboardAspectRatio(review.script, review.spec.aspect_ratio === "16:9" ? "16:9" : "9:16"),
      creation_spec: { ...review.spec, project_name: storyboardTheme(review.script) || review.spec.project_name, input_type: "SCRIPT" },
    });
  };
  const startDouyinStoryboard = () => {
    setVideoUnderstandingModeHandler(null);
    setShowStoryboardMode(true);
  };
  const confirmStoryboardMode = (selection: StoryboardUnderstandingSelection) => {
    setShowStoryboardMode(false);
    const localVideoHandler = videoUnderstandingModeHandler;
    setVideoUnderstandingModeHandler(null);
    if (localVideoHandler) {
      localVideoHandler(selection);
      return;
    }
    create.reset();
    douyinStoryboard.mutate(selection);
  };
  const closeStoryboardMode = () => {
    setShowStoryboardMode(false);
    setVideoUnderstandingModeHandler(null);
  };
  return (
    <div className="welcome-shell">
      <div className="welcome-glow" />
      <header className="welcome-header"><AccountEntry /><div className="welcome-actions"><button className="secondary-button toolbar-button" onClick={onOpenSettings}><Settings size={15} /> {t("systemSettings")}</button><button className="secondary-button toolbar-button" onClick={onOpenLogs}><ScrollText size={15} /> 日志</button><span>V0.3 · Local-first</span></div></header>
      <main className="create-layout">
        <aside className="create-navigation" aria-label="创建方式">
          <nav className="source-options">
            <button className={!showProjectCenter && !showAssetLibrary && sourceType === "DOUYIN_URL" ? "active" : ""} onClick={() => selectSourceType("DOUYIN_URL")}><Link2 size={18} /><span>{t("douyinLink")}<small>{t("douyinHint")}</small></span></button>
            <button className={!showProjectCenter && !showAssetLibrary && sourceType === "VIDEO_UNDERSTANDING" ? "active" : ""} onClick={() => selectSourceType("VIDEO_UNDERSTANDING")}><ScanSearch size={18} /><span>{t("videoUnderstanding")}<small>{t("videoHint")}</small></span></button>
            <button className={!showProjectCenter && !showAssetLibrary && sourceType === "IDEA" ? "active" : ""} onClick={() => selectSourceType("IDEA")}><Lightbulb size={18} /><span>{t("startIdea")}<small>{t("ideaHint")}</small></span></button>
            <button className={!showProjectCenter && !showAssetLibrary && sourceType === "SCRIPT_FILE" ? "active" : ""} onClick={() => selectSourceType("SCRIPT_FILE")}><Upload size={18} /><span>{t("scriptFile")}<small>{t("scriptFileHint")}</small></span></button>
            <button className={showProjectCenter ? "active" : ""} onClick={openProjectCenter}><FolderOpen size={18} /><span>项目中心<small>查看并打开本地项目</small></span></button>
            <button className={showAssetLibrary ? "active" : ""} onClick={openAssetLibrary}><Images size={18} /><span>资产库<small>场景、角色与道具图片</small></span></button>
          </nav>
          <div className="create-navigation-footer"><span className="status-dot" /> 服务端接口已连接</div>
        </aside>
        <section className="create-card create-workspace-panel">
          {showAssetLibrary ? <AssetLibraryPanel assets={assetLibrary.data ?? []} loading={assetLibrary.isLoading || assetLibrary.isFetching} error={assetLibrary.error} onRefresh={() => assetLibrary.refetch()} /> : showProjectCenter ? <ProjectCenterPanel projects={projectList.data ?? []} loading={projectList.isPending} loadingProjectId={openProject.variables?.id} onRefresh={() => projectList.mutate()} onOpen={(project) => openProject.mutate(project)} onDelete={setProjectPendingDelete} /> : sourceType === "VIDEO_UNDERSTANDING" ? <VideoUnderstandingPanel
            onRequestModeSelection={(handler) => { setVideoUnderstandingModeHandler(() => handler); setShowStoryboardMode(true); }}
            onTaskCreated={async () => { await localVideoTasks.refetch(); }}
            records={<DouyinTaskList
              variant="local"
              tasks={localVideoTasks.data ?? []}
              loading={localVideoTasks.isLoading}
              retryingTaskId={retryLocalVideoTask.variables}
              onRetry={(taskId) => retryLocalVideoTask.mutate(taskId)}
              deletingTaskId={deleteUnderstandingTask.variables}
              onDelete={confirmDeleteUnderstandingTask}
              deleteError={deleteUnderstandingTask.error}
              onOpenResult={openLocalVideoTaskResult}
              renderResult={(task) => { const review = localVideoTaskReviews[task.id]; return review ? <DouyinStoryboardReview script={review.script} onScriptChange={(script) => updateLocalVideoTaskReview(task.id, { script })} spec={review.spec} onSpecChange={(nextSpec) => updateLocalVideoTaskReview(task.id, { spec: nextSpec })} visualStyles={aiSettings.data?.visual_style_presets ?? []} rootPath={review.rootPath} onRootPathChange={(nextRootPath) => updateLocalVideoTaskReview(task.id, { rootPath: nextRootPath })} onSelectRoot={() => void selectLocalVideoRoot(task.id)} onCreate={() => submitLocalVideoProject(task.id)} creating={create.isPending && creatingDouyinTaskId === task.id} createError={creatingDouyinTaskId === task.id ? create.error : undefined} remixPanel={<VideoRemixPanel sourceTask={task} visualStyles={aiSettings.data?.visual_style_presets ?? []} defaultRootPath={review.rootPath} defaultSpec={review.spec} onProjectCreated={onReady} />} /> : <div className="douyin-review-loading"><LoaderCircle className="spin" size={18} />正在准备该任务内容…</div>; }}
            />}
          /> : sourceType === "DOUYIN_URL" ? <><ModelCreditNotice capability="VIDEO_UNDERSTANDING" />
            <label>视频分享链接或分享文案<textarea rows={5} value={sourceText} placeholder="粘贴视频分享文案或完整链接" onChange={(event) => { setSourceText(event.target.value); douyin.reset(); download.reset(); douyinStoryboard.reset(); }} /></label>
            <label>Cookie 来源（可选）<select value={cookieSource} onChange={(event) => { setCookieSource(event.target.value as CookieSource); douyin.reset(); download.reset(); douyinStoryboard.reset(); }}><option value="managed">自动识别平台并解析（推荐）</option><option value="">不使用 Cookie</option><option value="edge">Microsoft Edge</option><option value="chrome">Google Chrome</option><option value="firefox">Mozilla Firefox</option><option value="file">Cookie 文件（Netscape 格式）</option></select><small className="cookie-guidance">自动模式会识别抖音、快手或哔哩哔哩并直接解析公开视频；抖音需要登录时会使用程序专用浏览器，其他平台也可手动选择浏览器 Cookie 或 Cookie 文件。</small></label>
            {autoLoginUnavailable && cookieSource === "managed" && <div className="browser-warning"><AlertTriangle size={18} /><div><strong>未检测到 Chrome 或 Microsoft Edge</strong><span>快手、哔哩哔哩和无需登录的抖音链接仍可直接解析；仅抖音触发登录验证时需要安装浏览器或改用 Cookie 文件。</span></div><button type="button" onClick={() => browserAvailability.refetch()} disabled={browserAvailability.isFetching}>{browserAvailability.isFetching ? "检测中…" : "重新检测"}</button></div>}
            {browserAvailability.error && <div className="browser-warning"><AlertTriangle size={18} /><div><strong>暂时无法检测浏览器</strong><span>{readableError(browserAvailability.error)}</span></div><button type="button" onClick={() => browserAvailability.refetch()}>重试</button></div>}
            {cookieSource === "file" && <label>Cookie 文件<button className="file-picker" type="button" onClick={selectCookieFile}><FileText size={18} /><span>{cookieFilePath || "点击选择 cookies.txt"}</span></button></label>}
            {douyin.error && <div className="error-banner">{readableError(douyin.error)}</div>}
            <div className="douyin-resolve-action"><button className="primary-button" onClick={() => { douyinStoryboard.reset(); douyin.mutate({ shareText: sourceText.trim(), managed: cookieSource === "managed", browserCookieSource: cookieSource && cookieSource !== "file" && cookieSource !== "managed" ? cookieSource : undefined, cookieFilePath: cookieSource === "file" ? cookieFilePath : undefined }); }} disabled={douyin.isPending || !isSourceValid || !isCookieReady}>
              {douyin.isPending ? <><LoaderCircle className="spin" size={18} /> {cookieSource === "managed" ? "正在识别平台并解析视频…" : "正在解析视频…"}</> : <><Link2 size={18} /> {cookieSource === "managed" ? "自动识别并解析" : cookieSource === "file" ? "使用 Cookie 文件解析" : cookieSource ? `使用 ${cookieSource === "edge" ? "Edge" : cookieSource === "chrome" ? "Chrome" : "Firefox"} Cookie 解析` : "解析下载地址"} <ChevronRight size={18} /></>}
            </button></div>
            {douyin.data && <DouyinResult info={douyin.data} onDownload={() => startDownload(douyin.data)} downloading={download.isPending} downloadResult={download.data} downloadError={download.error} onGenerateStoryboard={startDouyinStoryboard} generatingStoryboard={douyinStoryboard.isPending} storyboardError={douyinStoryboard.error} />}
            <DouyinTaskList tasks={douyinTasks.data ?? []} loading={douyinTasks.isLoading} retryingTaskId={retryDouyinTask.variables} onRetry={(taskId) => retryDouyinTask.mutate(taskId)} deletingTaskId={deleteUnderstandingTask.variables} onDelete={confirmDeleteUnderstandingTask} deleteError={deleteUnderstandingTask.error} onOpenResult={openDouyinTaskResult} renderResult={(task) => { const review = douyinTaskReviews[task.id]; return review ? <DouyinStoryboardReview script={review.script} onScriptChange={(script) => updateDouyinTaskReview(task.id, { script })} spec={review.spec} onSpecChange={(nextSpec) => updateDouyinTaskReview(task.id, { spec: nextSpec })} visualStyles={aiSettings.data?.visual_style_presets ?? []} rootPath={review.rootPath} onRootPathChange={(nextRootPath) => updateDouyinTaskReview(task.id, { rootPath: nextRootPath })} onSelectRoot={() => void selectDouyinTaskRoot(task.id)} onCreate={() => submitStoryboardProject(task.id)} creating={create.isPending && creatingDouyinTaskId === task.id} createError={creatingDouyinTaskId === task.id ? create.error : undefined} remixPanel={<VideoRemixPanel sourceTask={task} visualStyles={aiSettings.data?.visual_style_presets ?? []} defaultRootPath={review.rootPath} defaultSpec={review.spec} onProjectCreated={onReady} />} /> : <div className="douyin-review-loading"><LoaderCircle className="spin" size={18} />正在准备该任务内容…</div>; }} />
            <p className="resolver-notice">仅解析您有权访问和使用的公开视频。媒体地址由平台签名，可能在一段时间后失效。</p>
          </> : <>
            <label>{t("projectName")}<input value={spec.project_name} onChange={(event) => setSpec({ ...spec, project_name: event.target.value })} /></label>
            {sourceType === "IDEA" && <label>创作类型<button className={selectedCreativeType ? "creative-type-picker selected" : "creative-type-picker"} type="button" onClick={() => setShowCreativeTypeSelector(true)}>
              <span><BookOpen size={18} /><span><strong>{selectedCreativeType?.name || "请选择创作类型"}</strong><small>{selectedCreativeType?.description || "从经典电影、电视剧、短剧和漫剧类型中选择"}</small></span></span><ChevronRight size={18} />
            </button><small>类型提示词用于第一步整体大纲；只有确认大纲后，才会继续拆分分集。</small></label>}
            {sourceType === "IDEA" && <label>一句话创意<textarea rows={4} value={sourceText} onChange={(event) => setSourceText(event.target.value)} /></label>}
            {sourceType === "SCRIPT_FILE" && <label>剧本文件<button className="file-picker" onClick={selectScript}><Upload size={18} /><span>{sourcePath || "点击选择 TXT、MD、DOCX 或 PDF"}</span></button></label>}
            <div className={sourceType === "IDEA" ? "field-grid idea-creation-fields" : "field-grid"}>
              <label>{t("targetDuration")}<div className="unit-input"><input type="number" min={5} max={3600} step={1} value={spec.target_duration} onChange={(event) => setSpec({ ...spec, target_duration: Number(event.target.value) })} /><span>{t("seconds")}</span></div></label>
              <label>{t("aspectRatio")}<select value={spec.aspect_ratio} onChange={(event) => setSpec({ ...spec, aspect_ratio: event.target.value })}><option>9:16</option><option>16:9</option></select></label>
              <label>{t("projectLanguage")}<select value={spec.language} onChange={(event) => setSpec({ ...spec, language: event.target.value })}>{supportedLocales.map((item) => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</select></label>
              <GroupedVisualStyleSelect value={spec.visual_style} onChange={(visual_style) => setSpec({ ...spec, visual_style })} presets={visualStyles.data ?? []} categories={visualStyleCategories.data?.map((item) => item.name)} />
              {sourceType !== "IDEA" && <label>{t("creationMode")}<select value={spec.creation_mode} onChange={(event) => setSpec({ ...spec, creation_mode: event.target.value as CreationSpec["creation_mode"] })}><option value="DIRECTOR">导演模式</option><option value="QUICK">快速模式</option><option value="PROFESSIONAL">专业模式</option></select></label>}
            </div>
            <label>{t("projectRoot")}<div className="path-input"><FolderOpen size={17} /><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} /><button type="button" onClick={selectRoot}>{t("choose")}</button></div></label>
            {sourceType === "IDEA" && <ModelCreditNotice capability="TEXT_GENERATION" action="大纲生成" />}
            {create.error && <div className="error-banner">{readableError(create.error)}</div>}
            <button className="primary-button" onClick={submit} disabled={create.isPending || !isSourceValid || !spec.project_name.trim() || !rootPath.trim() || (sourceType === "IDEA" && !selectedCreativeType)}>
              {create.isPending ? <><LoaderCircle className="spin" size={18} /> {t("creating")}</> : <><Sparkles size={18} /> {t("createLocalProject")}（{sourceType === "IDEA" ? "生成大纲需积分" : "免费"}） <ChevronRight size={18} /></>}
            </button>
            {ideaWorkflowBundle && <button className="secondary-button long-form-open-progress" type="button" onClick={() => setShowIdeaWorkflow(true)}><History size={17} /> 打开创意分步向导</button>}
            {initialBundle && <p className="hint">已创建项目骨架，请在创意分步向导中完成大纲、分集、角色场景和分镜确认。</p>}
          </>}
          {(openProject.error || projectList.error) && <div className="error-banner">{readableError(openProject.error ?? projectList.error)}</div>}
        </section>
      </main>
      {showCreativeTypeSelector && <CreativeTypeSelectorModal types={creativeTypes} categoryNames={creativeTypeCategories.data?.map((item) => item.name)} selectedId={spec.creative_type_id} loading={aiSettings.isLoading || creativeTypeCategories.isLoading} onClose={() => setShowCreativeTypeSelector(false)} onSelect={(preset) => { setSpec((current) => ({ ...current, creative_type_id: preset.id, creative_type_category: preset.category, creative_type_name: preset.name, creative_type_prompt: preset.prompt })); setShowCreativeTypeSelector(false); }} />}
      {showStoryboardMode && <StoryboardModeModal onClose={closeStoryboardMode} onSelect={confirmStoryboardMode} />}
      {showIdeaWorkflow && ideaWorkflowBundle && <IdeaDevelopmentProgressModal workflow={ideaWorkflow.data} loading={ideaWorkflow.isLoading} fallbackError={ideaWorkflowAction.error ?? create.error} running={create.isPending || ideaWorkflowAction.isPending || ideaWorkflow.data?.status === "RUNNING"} onClose={() => setShowIdeaWorkflow(false)} onAction={(action, payload) => { ideaWorkflowAction.reset(); ideaWorkflowAction.mutate({ action, payload }); }} />}
      {projectPendingDelete && <DeleteProjectConfirmModal project={projectPendingDelete} deleting={deleteLocalProject.isPending} error={deleteLocalProject.error} onCancel={() => { if (!deleteLocalProject.isPending) { deleteLocalProject.reset(); setProjectPendingDelete(undefined); } }} onConfirm={() => deleteLocalProject.mutate(projectPendingDelete)} />}
    </div>
  );
}

function IdeaDevelopmentProgressModal({ workflow, loading, fallbackError, running, onClose, onAction }: { workflow?: IdeaDevelopmentWorkflow | null; loading: boolean; fallbackError?: unknown; running: boolean; onClose: () => void; onAction: (action: IdeaDevelopmentAction, payload?: Record<string, unknown>) => void }) {
  const [storyDraft, setStoryDraft] = useState(workflow?.snapshot.story);
  const [episodesDraft, setEpisodesDraft] = useState<Episode[]>(workflow?.snapshot.episodes ?? []);
  const [charactersDraft, setCharactersDraft] = useState<Character[]>(workflow?.snapshot.characters ?? []);
  const [scenesDraft, setScenesDraft] = useState<Scene[]>(workflow?.snapshot.scenes ?? []);
  useEffect(() => {
    setStoryDraft(workflow?.snapshot.story);
    setEpisodesDraft(workflow?.snapshot.episodes ?? []);
    setCharactersDraft(workflow?.snapshot.characters ?? []);
    setScenesDraft(workflow?.snapshot.scenes ?? []);
  }, [workflow?.updated_at]);
  const supportedStages = ["outline_review", "episodes_review", "assets_review", "storyboards", "storyboards_review", "completed"];
  const legacyStage = Boolean(workflow && !supportedStages.includes(workflow.stage));
  const currentIndex = workflow?.stage === "episodes_review" ? 1 : workflow?.stage === "assets_review" ? 2 : ["storyboards", "storyboards_review"].includes(workflow?.stage ?? "") ? 3 : workflow?.stage === "completed" ? 4 : 0;
  const steps = [
    ["整体大纲", "不超过3000字，可修改或重新生成"],
    ["拆分分集", "每集约1至2分钟并保存到数据库"],
    ["角色与场景", "从全部分集提取，可增删改"],
    ["分镜脚本", "按每集具体剧情逐集生成"],
  ];
  const storyboardDrafts = (workflow?.snapshot.completed_episode_storyboards ?? []) as Array<{ segment_id?: string; episode_summary?: unknown; segment_summary?: unknown; shots?: Shot[] }>;
  const completedStoryboards = workflow?.snapshot.completed_episode_storyboards?.length ?? 0;
  const error = workflow?.error?.message || (fallbackError ? readableError(fallbackError) : "");
  const waiting = workflow?.status === "WAITING_INPUT" && !running;
  const updateEpisode = (id: string, patch: Partial<Episode>) => setEpisodesDraft((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateCharacterDraft = (id: string, patch: Partial<Character>) => setCharactersDraft((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateCharacterStateDraft = (characterId: string, stateId: string, patch: Partial<CharacterState>) => setCharactersDraft((items) => items.map((character) => character.id === characterId ? { ...character, states: characterStates(character).map((state) => state.id === stateId ? { ...state, ...patch } : state) } : character));
  const addCharacterStateDraft = (characterId: string) => setCharactersDraft((items) => items.map((character) => {
    if (character.id !== characterId) return character;
    const states = characterStates(character);
    return { ...character, states: [...states, { id: `${character.id}_STATE_${String(states.length + 1).padStart(3, "0")}`, name: "新状态", trigger: "", description: "", appearance_lock: character.appearance_lock ?? character.appearance.face, clothing_lock: "", reference_assets: [], locked: false }] };
  }));
  const removeCharacterStateDraft = (characterId: string, stateId: string) => setCharactersDraft((items) => items.map((character) => character.id === characterId ? { ...character, states: characterStates(character).filter((state) => state.id !== stateId) } : character));
  const updateSceneDraft = (id: string, patch: Partial<Scene>) => setScenesDraft((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const retryAction: IdeaDevelopmentAction = workflow?.stage === "episodes_review" ? "retry_episodes" : workflow?.stage === "assets_review" ? "retry_assets" : ["storyboards", "storyboards_review"].includes(workflow?.stage ?? "") ? "retry_storyboards" : "retry_outline";
  const outlineLength = storyDraft?.synopsis?.length ?? 0;
  return createPortal(<div className="modal-backdrop">
    <section className="idea-workflow-modal guided-idea-modal" role="dialog" aria-modal="true" aria-labelledby="idea-workflow-title">
      <header><div><span className="eyebrow">GUIDED IDEA CREATION</span><h2 id="idea-workflow-title">创意剧本与分镜向导</h2><p>无论时长，每一步都由你确认；未确认前不会生成下一步。</p></div><button className="modal-close" type="button" onClick={onClose}><X size={18} /></button></header>
      <div className="guided-stepper">{steps.map(([title, description], index) => <div className={currentIndex > index || workflow?.status === "COMPLETED" ? "completed" : currentIndex === index ? "active" : ""} key={title}><span>{currentIndex > index || workflow?.status === "COMPLETED" ? <Check size={15} /> : index + 1}</span><div><strong>{title}</strong><small>{description}</small></div></div>)}</div>
      <div className="idea-workflow-overall"><div><span>{workflow?.message || (loading ? "正在读取工作流状态…" : "正在初始化项目…")}</span><strong>{Math.round((workflow?.progress ?? 0) * 100)}%</strong></div><i><b style={{ width: `${Math.round((workflow?.progress ?? 0) * 100)}%` }} /></i></div>
      <div className="guided-workflow-body">
        {(loading || running) && <div className="guided-running"><LoaderCircle className="spin" size={30} /><strong>{workflow?.message || "AI正在处理当前步骤"}</strong><span>{workflow?.stage === "storyboards" && episodesDraft.length ? `已完成 ${completedStoryboards} / ${episodesDraft.length} 集` : "完成后会自动停在下一确认步骤"}</span></div>}
        {!running && workflow?.stage === "outline_review" && storyDraft && <section className="guided-editor outline-editor"><header><div><span>STEP 01</span><h3>整体大纲</h3></div><em className={outlineLength > 3000 ? "over" : ""}>{outlineLength} / 3000字</em></header><div className="guided-two-columns"><label>片名<input value={storyDraft.title} onChange={(event) => setStoryDraft({ ...storyDraft, title: event.target.value })} /></label><label>主题<input value={storyDraft.theme} onChange={(event) => setStoryDraft({ ...storyDraft, theme: event.target.value })} /></label></div><label>一句话梗概<textarea rows={2} value={storyDraft.logline} onChange={(event) => setStoryDraft({ ...storyDraft, logline: event.target.value })} /></label><label>整体大纲<textarea rows={15} maxLength={3000} value={storyDraft.synopsis} onChange={(event) => setStoryDraft({ ...storyDraft, synopsis: event.target.value })} /></label><label>基调<input value={storyDraft.tone} onChange={(event) => setStoryDraft({ ...storyDraft, tone: event.target.value })} /></label></section>}
        {!running && workflow?.stage === "episodes_review" && <section className="guided-editor episode-editor"><header><div><span>STEP 02</span><h3>分集内容</h3></div><button className="secondary-button" type="button" onClick={() => setEpisodesDraft((items) => [...items, { id: `EP_${String(items.length + 1).padStart(3, "0")}`, order: items.length + 1, title: `第${items.length + 1}集`, duration: 90, content: "" }])}><Plus size={15} />添加分集</button></header><div className="guided-card-list">{episodesDraft.map((episode, index) => <article key={episode.id}><header><span>{String(index + 1).padStart(2, "0")}</span><input value={episode.title} onChange={(event) => updateEpisode(episode.id, { title: event.target.value })} /><label>时长<input type="number" min={60} max={120} value={Math.round(episode.duration)} onChange={(event) => updateEpisode(episode.id, { duration: Number(event.target.value) })} /><small>秒</small></label><button type="button" title="删除分集" onClick={() => setEpisodesDraft((items) => items.filter((item) => item.id !== episode.id))}><X size={15} /></button></header><textarea rows={8} value={episode.content} placeholder="写清本集实际发生的事件、人物行动、冲突、转折与结尾钩子" onChange={(event) => updateEpisode(episode.id, { content: event.target.value })} /></article>)}</div></section>}
        {!running && workflow?.stage === "assets_review" && <section className="guided-editor assets-editor"><header><div><span>STEP 03</span><h3>角色与场景</h3></div><small>{charactersDraft.length}个角色 · {scenesDraft.length}个场景</small></header><div className="guided-assets-columns"><div><header><strong>角色</strong><button type="button" onClick={() => setCharactersDraft((items) => { const id = `CHAR_${String(items.length + 1).padStart(3, "0")}`; return [...items, { id, name: "新角色", role: "剧情角色", gender: "未指定", age_range: "未指定", appearance: { face: "", hair: "", body: "", clothes: "", accessories: "" }, voice: "", appearance_lock: "", clothing_lock: "", voice_lock: "", story_function: "", locked: false, reference_assets: [], states: [{ id: `${id}_STATE_001`, name: "默认状态", trigger: "角色常规出场", description: "", appearance_lock: "", clothing_lock: "", reference_assets: [], locked: false }] }]; })}><Plus size={14} />添加</button></header>{charactersDraft.map((character) => <article key={character.id}><header><input value={character.name} onChange={(event) => updateCharacterDraft(character.id, { name: event.target.value })} /><button type="button" onClick={() => setCharactersDraft((items) => items.filter((item) => item.id !== character.id))}><X size={14} /></button></header><input value={character.role} placeholder="角色定位" onChange={(event) => updateCharacterDraft(character.id, { role: event.target.value })} /><textarea rows={3} value={character.appearance_lock ?? character.appearance.face} placeholder="角色基础外貌锁定" onChange={(event) => updateCharacterDraft(character.id, { appearance_lock: event.target.value })} /><div className="guided-character-states"><header><strong>角色状态</strong><button type="button" onClick={() => addCharacterStateDraft(character.id)}><Plus size={13} />添加状态</button></header>{characterStates(character).map((state) => <section key={state.id}><header><input value={state.name} placeholder="状态名称" onChange={(event) => updateCharacterStateDraft(character.id, state.id, { name: event.target.value })} /><button type="button" disabled={characterStates(character).length <= 1} onClick={() => removeCharacterStateDraft(character.id, state.id)}><X size={13} /></button></header><input value={state.trigger} placeholder="出现条件，例如：完成神变后" onChange={(event) => updateCharacterStateDraft(character.id, state.id, { trigger: event.target.value })} /><textarea rows={2} value={state.description} placeholder="该状态的完整视觉说明" onChange={(event) => updateCharacterStateDraft(character.id, state.id, { description: event.target.value })} /><textarea rows={2} value={state.appearance_lock} placeholder="该状态外貌锁定" onChange={(event) => updateCharacterStateDraft(character.id, state.id, { appearance_lock: event.target.value })} /><textarea rows={2} value={state.clothing_lock} placeholder="该状态服装、装备、伤势锁定" onChange={(event) => updateCharacterStateDraft(character.id, state.id, { clothing_lock: event.target.value })} /></section>)}</div></article>)}</div><div><header><strong>场景</strong><button type="button" onClick={() => setScenesDraft((items) => [...items, { id: `SCENE_${String(items.length + 1).padStart(3, "0")}`, name: "新场景", location_type: "", time_of_day: "", description: "", lighting: "", layout: "", props: [], mood: "", locked: false, reference_assets: [] }])}><Plus size={14} />添加</button></header>{scenesDraft.map((scene) => <article key={scene.id}><header><input value={scene.name} onChange={(event) => updateSceneDraft(scene.id, { name: event.target.value })} /><button type="button" onClick={() => setScenesDraft((items) => items.filter((item) => item.id !== scene.id))}><X size={14} /></button></header><div className="guided-two-columns"><input value={scene.location_type} placeholder="内景/外景" onChange={(event) => updateSceneDraft(scene.id, { location_type: event.target.value })} /><input value={scene.time_of_day} placeholder="时间" onChange={(event) => updateSceneDraft(scene.id, { time_of_day: event.target.value })} /></div><textarea rows={4} value={scene.description} placeholder="详细描述空间结构、材质、陈设、出入口和视觉特征" onChange={(event) => updateSceneDraft(scene.id, { description: event.target.value })} /><textarea rows={2} value={scene.lighting} placeholder="光线设计" onChange={(event) => updateSceneDraft(scene.id, { lighting: event.target.value })} /><textarea rows={2} value={scene.layout} placeholder="空间布局" onChange={(event) => updateSceneDraft(scene.id, { layout: event.target.value })} /></article>)}</div></div></section>}
        {!running && workflow?.stage === "storyboards" && <section className="guided-editor storyboard-resume"><Clapperboard size={32} /><h3>分镜脚本生成在当前集停止</h3><p>已完成 {completedStoryboards} / {episodesDraft.length} 集。继续时会从第一集未完成内容开始，已完成分镜不会重新生成。</p></section>}
        {!running && workflow?.stage === "storyboards_review" && <section className="guided-editor storyboard-review"><header><div><span>STEP 04</span><h3>逐集分镜脚本</h3></div><small>{storyboardDrafts.length}集 · {storyboardDrafts.reduce((sum, item) => sum + (item.shots?.length ?? 0), 0)}个分镜</small></header><div className="guided-storyboard-list">{storyboardDrafts.map((draft, index) => { const episode = episodesDraft.find((item) => item.id === draft.segment_id) ?? episodesDraft[index]; return <details key={draft.segment_id ?? index} open={index === 0}><summary><span>{String(index + 1).padStart(2, "0")}</span><strong>{episode?.title ?? `第${index + 1}集`}</strong><em>{draft.shots?.length ?? 0}个分镜</em></summary><p>{workflowSummaryText(draft.episode_summary, draft.segment_summary) || workflowSummaryText(episode?.content)}</p><div>{draft.shots?.map((shot, shotIndex) => <article key={shot.id}><header><span>{String(shotIndex + 1).padStart(2, "0")}</span><strong>{shot.shot_size} · {shot.camera_angle}</strong><em>{shot.duration}秒</em></header><p><b>运镜</b>{shot.camera_movement}</p><p><b>画面</b>{shot.visual}</p><p><b>动作</b>{shot.action}</p><p><b>台词</b>{shot.dialogue || "无"}</p></article>)}</div></details>; })}</div></section>}
        {!running && legacyStage && <section className="guided-editor storyboard-resume"><BookOpen size={32} /><h3>检测到旧版长篇工作流</h3><p>旧版按抽象分段直接生成分镜，无法提供新的逐步确认内容。切换新版后会基于原始Idea重新生成第一步整体大纲，不会改动其他已完成项目。</p></section>}
        {error && !running && <div className="idea-workflow-error"><AlertTriangle size={18} /><div><strong>当前步骤未完成</strong><span>{error}</span><small>模型请求已自动重试3次；现在可手动重试当前步骤，之前确认的数据不会丢失。</small></div></div>}
      </div>
      <footer><span>{running ? "可以关闭窗口，当前AI任务会继续执行。" : waiting ? "请检查并确认当前步骤后继续。" : "所有修改均可在确认前保存。"}</span>{waiting && <button className="secondary-button danger" type="button" onClick={() => onAction("cancel")}>取消流程</button>}{!running && legacyStage && <button className="primary-button" type="button" onClick={() => onAction("retry_outline")}><RotateCcw size={16} />切换到新版分步流程</button>}{!running && workflow?.status === "FAILED" && !legacyStage && <button className="primary-button" type="button" onClick={() => onAction(retryAction)}><RotateCcw size={16} />重试当前步骤</button>}{waiting && workflow?.stage === "outline_review" && storyDraft && <><button className="secondary-button" type="button" onClick={() => onAction("regenerate_outline")}><RotateCcw size={16} />重新生成</button><button className="secondary-button" type="button" onClick={() => onAction("save_outline", { story: storyDraft })}><Save size={16} />保存修改</button><button className="primary-button" type="button" disabled={outlineLength < 40 || outlineLength > 3000} onClick={() => onAction("confirm_outline", { story: storyDraft })}><CheckCircle2 size={16} />确认并拆分分集</button></>}{waiting && workflow?.stage === "episodes_review" && <><button className="secondary-button" type="button" onClick={() => onAction("regenerate_episodes")}><RotateCcw size={16} />重新生成</button><button className="secondary-button" type="button" onClick={() => onAction("save_episodes", { episodes: episodesDraft })}><Save size={16} />保存修改</button><button className="primary-button" type="button" disabled={!episodesDraft.length || episodesDraft.some((item) => item.content.trim().length < 30)} onClick={() => onAction("confirm_episodes", { episodes: episodesDraft })}><CheckCircle2 size={16} />确认并提取角色场景</button></>}{waiting && workflow?.stage === "assets_review" && <><button className="secondary-button" type="button" onClick={() => onAction("regenerate_assets")}><RotateCcw size={16} />重新提取</button><button className="secondary-button" type="button" onClick={() => onAction("save_assets", { characters: charactersDraft, scenes: scenesDraft })}><Save size={16} />保存修改</button><button className="primary-button" type="button" disabled={!charactersDraft.length || !scenesDraft.length || scenesDraft.some((item) => item.description.trim().length < 15)} onClick={() => onAction("confirm_assets", { characters: charactersDraft, scenes: scenesDraft })}><CheckCircle2 size={16} />确认并生成分镜</button></>}{waiting && workflow?.stage === "storyboards_review" && <><button className="secondary-button" type="button" onClick={() => onAction("regenerate_storyboards")}><RotateCcw size={16} />重新生成全部分镜</button><button className="primary-button" type="button" disabled={storyboardDrafts.length !== episodesDraft.length} onClick={() => onAction("confirm_storyboards")}><CheckCircle2 size={16} />确认分镜并完成项目</button></>}<button className="secondary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}

function CreativeTypeSelectorModal({ types, categoryNames, selectedId, loading, onClose, onSelect }: { types: CreativeTypePreset[]; categoryNames?: string[]; selectedId?: string; loading: boolean; onClose: () => void; onSelect: (preset: CreativeTypePreset) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const categories = ["全部", ...(categoryNames?.length ? categoryNames : Array.from(new Set(types.map((item) => item.category))))];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = types.filter((item) => (category === "全部" || item.category === category) && (!normalizedQuery || `${item.name} ${item.description} ${item.category}`.toLocaleLowerCase().includes(normalizedQuery)));
  return <div className="modal-backdrop creative-type-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="creative-type-modal" role="dialog" aria-modal="true" aria-labelledby="creative-type-title">
      <header><div><span className="eyebrow">CREATIVE GENRE</span><h2 id="creative-type-title">选择创作类型</h2><p>类型将决定故事结构、冲突方式、人物关系和整体叙事节奏，数据由服务端创作类型目录统一提供。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="creative-type-toolbar"><div className="creative-type-search"><ScanSearch size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索战争、神话、宫斗、港剧、科幻、短剧……" /></div><span>共 {types.length} 种经典类型</span></div>
      <div className="creative-type-categories">{categories.map((item) => <button className={category === item ? "active" : ""} data-category={item} type="button" key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="creative-type-grid">{loading ? <div className="creative-type-empty"><LoaderCircle className="spin" /> 正在读取类型库…</div> : visible.map((preset) => <button className={selectedId === preset.id ? "creative-type-card active" : "creative-type-card"} data-category={preset.category} type="button" key={preset.id} onClick={() => onSelect(preset)}><span>{preset.category}</span><strong>{preset.name}</strong><small>{preset.description}</small><em>{selectedId === preset.id ? <><Check size={14} /> 当前选择</> : "点击选择"}</em></button>)}{!loading && visible.length === 0 && <div className="creative-type-empty">没有找到匹配的创作类型</div>}</div>
      <footer><span>如果不确定，可从“现实主义剧情”“都市情感”或“热血少年漫”开始。</span><button className="secondary-button" type="button" onClick={onClose}>取消</button></footer>
    </section>
  </div>;
}

function DouyinResult({ info, onDownload, downloading, downloadResult, downloadError, onGenerateStoryboard, generatingStoryboard, storyboardError }: { info: DouyinVideoInfo; onDownload: () => void; downloading: boolean; downloadResult?: DouyinDownloadResult; downloadError?: Error | null; onGenerateStoryboard: () => void; generatingStoryboard: boolean; storyboardError?: Error | null }) {
  const [copied, setCopied] = useState(false);
  const copyUrl = async () => {
    await navigator.clipboard.writeText(info.download_url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const duration = info.duration == null ? "未知" : `${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, "0")}`;
  const resolution = info.width && info.height ? `${info.width} × ${info.height}` : "未知";
  return <section className="douyin-result">
    <div className="douyin-summary">
      {info.thumbnail ? <img src={info.thumbnail} alt="视频封面" referrerPolicy="no-referrer" /> : <div className="douyin-placeholder"><Clapperboard size={28} /></div>}
      <div><span className="result-status"><CheckCircle2 size={14} /> 已识别为{videoPlatformLabel(info.platform)}，可创建后台任务</span><strong>{info.title || "未命名视频"}</strong><small>{info.uploader || "未知作者"} · {duration}</small></div>
    </div>
    <div className="douyin-meta"><span>{resolution}</span><span>{info.ext.toUpperCase()}</span><span>{info.format_id || "AUTO"}</span></div>
    <label>视频下载地址<div className="result-url"><input readOnly value={info.download_url} /><div className="result-actions"><button type="button" onClick={copyUrl}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : "复制"}</button><button type="button" onClick={onDownload} disabled={downloading || generatingStoryboard}>{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{downloading ? "下载中…" : "下载"}</button><button className="storyboard-action" type="button" onClick={onGenerateStoryboard} disabled={generatingStoryboard || downloading}>{generatingStoryboard ? <LoaderCircle className="spin" size={16} /> : <ScanSearch size={16} />}{generatingStoryboard ? "正在加入后台队列…" : "后台生成分镜"}</button></div></div></label>
    {downloadError && <div className="error-banner download-message">{readableError(downloadError)}</div>}
    {storyboardError && <div className="error-banner download-message">{readableError(storyboardError)}</div>}
    {downloadResult && <div className="download-success"><CheckCircle2 size={16} /><span>已保存到：{downloadResult.saved_path}</span></div>}
  </section>;
}

const douyinTaskStageLabels: Record<string, string> = {
  queued: "等待执行", preparing: "准备任务", downloading: "下载视频", compressing: "压缩分析副本",
  processing: "处理并上传本地视频", analyzing: "AI理解并生成分镜", completed: "已完成", failed: "执行失败",
};

function DouyinTaskList({ tasks, loading, retryingTaskId, onRetry, deletingTaskId, onDelete, deleteError, onOpenResult, renderResult, variant = "link" }: { tasks: DouyinUnderstandingTask[]; loading: boolean; retryingTaskId?: string; onRetry: (taskId: string) => void; deletingTaskId?: string; onDelete?: (taskId: string) => void; deleteError?: Error | null; onOpenResult?: (task: DouyinUnderstandingTask) => void; renderResult?: (task: DouyinUnderstandingTask) => ReactNode; variant?: "link" | "local" }) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const activeCount = tasks.filter((task) => task.status === "PENDING" || task.status === "RUNNING").length;
  return <section className={`douyin-task-center ${variant === "local" ? "local-video-task-center" : ""}`}>
    <header><div><span className="eyebrow">{variant === "local" ? "LOCAL VIDEO HISTORY" : "BACKGROUND TASKS"}</span><h3>{variant === "local" ? "视频理解记录" : "视频链接解析与理解任务"}</h3><p>{variant === "local" ? "本地视频理解结果保存在本机数据库中，可随时重新打开、创建项目或进行二创。" : "任务保存在本机数据库中并可同时运行；提交后可以立即继续输入下一条链接。"}</p></div><span className={activeCount ? "task-count active" : "task-count"}>{activeCount ? `${activeCount} 个进行中` : `${tasks.length} 条记录`}</span></header>
    {deleteError && <div className="error-banner">删除失败：{readableError(deleteError)}</div>}
    {loading ? <div className="douyin-task-empty"><LoaderCircle className="spin" size={20} />正在读取任务…</div> : tasks.length === 0 ? <div className="douyin-task-empty">{variant === "local" ? "还没有视频理解任务。选择本地视频并提交后，任务会立即显示在这里。" : "还没有任务。解析视频并选择分镜模式后，任务会显示在这里。"}</div> : <div className="douyin-task-list">{tasks.map((task) => {
      const active = task.status === "PENDING" || task.status === "RUNNING";
      const expanded = expandedTaskIds.has(task.id);
      const duration = task.duration ? `${Math.floor(task.duration / 60)}:${String(Math.round(task.duration % 60)).padStart(2, "0")}` : "时长未知";
      return <article className={`douyin-task-card ${task.status.toLowerCase()}`} key={task.id}>
        <div className="douyin-task-main">{task.source_kind === "LOCAL" ? <video className="douyin-task-video" src={convertFileSrc(task.share_text)} controls preload="metadata" playsInline /> : task.thumbnail ? <img src={task.thumbnail} alt="视频封面" referrerPolicy="no-referrer" /> : <span className="douyin-task-cover"><Clapperboard size={22} /></span>}<div><strong>{task.title || "未命名视频"}</strong><small>{task.source_kind === "LOCAL" ? "本地视频" : videoPlatformLabel(task.platform)} · {task.uploader || "未知作者"} · {duration} · {task.mode === "detailed" ? "详细模式" : task.mode === "fixed" ? `固定${task.fixed_seconds ?? 10}秒` : "标准模式"}</small><em>{new Date(task.created_at).toLocaleString("zh-CN")}</em></div></div>
        <div className="douyin-task-state"><div><span>{active && <LoaderCircle className="spin" size={14} />}{task.status === "COMPLETED" && <CheckCircle2 size={14} />}{task.status === "FAILED" && <AlertTriangle size={14} />}{douyinTaskStageLabels[task.stage] || task.message}</span><strong>{Math.round(task.progress * 100)}%</strong></div><i><b style={{ width: `${Math.round(task.progress * 100)}%` }} /></i><small>{task.error?.message || task.message}</small></div>
        <div className="douyin-task-actions">{task.status === "FAILED" && <button className="secondary-button" type="button" disabled={retryingTaskId === task.id || deletingTaskId === task.id} onClick={() => onRetry(task.id)}>{retryingTaskId === task.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}重试</button>}{task.status === "COMPLETED" && <button className={expanded ? "secondary-button" : "primary-button"} type="button" disabled={deletingTaskId === task.id} onClick={() => setExpandedTaskIds((current) => { const next = new Set(current); if (next.has(task.id)) next.delete(task.id); else { next.add(task.id); onOpenResult?.(task); } return next; })}><ScrollText size={15} />{expanded ? "收起结果" : "查看结果"}</button>}{onDelete && <button className="secondary-button danger-button" type="button" disabled={deletingTaskId === task.id} onClick={() => onDelete(task.id)}>{deletingTaskId === task.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{deletingTaskId === task.id ? "删除中…" : "删除"}</button>}</div>
        {expanded && task.result?.text && <div className="douyin-task-inline-result">{renderResult ? renderResult(task) : <DouyinTaskReadOnlyResult task={task} />}</div>}
      </article>;
    })}</div>}
  </section>;
}

function DouyinTaskReadOnlyResult({ task }: { task: DouyinUnderstandingTask }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(task.result?.text ?? "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <section className="douyin-task-readonly-result"><header><div><span className="eyebrow">TASK RESULT</span><h4>{task.title || "视频分镜结果"}</h4></div><button className="secondary-button" type="button" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制结果"}</button></header><pre>{task.result?.text}</pre></section>;
}

function DouyinStoryboardReview({ script, onScriptChange, spec, onSpecChange, visualStyles, rootPath, onRootPathChange, onSelectRoot, onCreate, creating, createError, remixPanel }: { script: string; onScriptChange: (value: string) => void; spec: CreationSpec; onSpecChange: (value: CreationSpec) => void; visualStyles: import("@aivs/schemas").VisualStylePreset[]; rootPath: string; onRootPathChange: (value: string) => void; onSelectRoot: () => void; onCreate: () => void; creating: boolean; createError?: Error | null; remixPanel?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [savingText, setSavingText] = useState(false);
  const [savedTextPath, setSavedTextPath] = useState("");
  const [exportError, setExportError] = useState("");
  const copyScript = async () => {
    setExportError("");
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      setExportError(`复制失败：${readableError(error)}`);
    }
  };
  const saveScript = async () => {
    const safeName = (spec.project_name || "短视频").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "短视频";
    setSavingText(true);
    setSavedTextPath("");
    setExportError("");
    try {
      const savedPath = await saveTextAsTxt(script, `${safeName}_分镜脚本.txt`);
      if (savedPath) setSavedTextPath(savedPath);
    } catch (error) {
      setExportError(readableError(error));
    } finally {
      setSavingText(false);
    }
  };
  return <section className="storyboard-review">
    <p className="credit-free-notice">保存为文件或新项目都免费，不扣积分。</p>
    <header><div><span className="eyebrow">EDIT & CREATE</span><h3>编辑分镜脚本</h3><p>模型结果不会直接建项。请先检查人物、场景、台词与时间段，确认后再创建新项目。</p></div><span className="review-ready"><CheckCircle2 size={15} /> 待确认</span></header>
    <label>分镜脚本<textarea className="review-script" rows={28} value={script} onChange={(event) => { onScriptChange(event.target.value); setSavedTextPath(""); setExportError(""); }} /></label>
    <div className="field-grid review-fields">
      <label>项目名称<input value={spec.project_name} onChange={(event) => onSpecChange({ ...spec, project_name: event.target.value })} /></label>
      <label>目标时长<div className="unit-input"><input type="number" min={5} max={3600} step={1} value={spec.target_duration} onChange={(event) => onSpecChange({ ...spec, target_duration: Number(event.target.value) })} /><span>秒</span></div></label>
      <label>画面比例<select value={spec.aspect_ratio} onChange={(event) => onSpecChange({ ...spec, aspect_ratio: event.target.value })}><option>9:16</option><option>16:9</option></select></label>
      <GroupedVisualStyleSelect value={spec.visual_style} onChange={(visual_style) => onSpecChange({ ...spec, visual_style })} presets={visualStyles} automaticLabel="使用视频理解生成的画风" />
    </div>
    <label>项目根目录<div className="path-input"><FolderOpen size={17} /><input value={rootPath} onChange={(event) => onRootPathChange(event.target.value)} /><button type="button" onClick={onSelectRoot}>选择</button></div></label>
    {createError && <div className="error-banner">{readableError(createError)}</div>}
    <footer className="storyboard-export-footer">
      <div className="storyboard-final-actions">
        {remixPanel}
        <button className="secondary-button" type="button" onClick={() => void copyScript()} disabled={!script.trim()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? "已复制" : "一键复制"}</button>
        <button className="secondary-button" type="button" onClick={() => void saveScript()} disabled={savingText || !script.trim()}>{savingText ? <LoaderCircle className="spin" size={17} /> : <FileDown size={17} />}{savingText ? "正在保存…" : "另存为 TXT"}</button>
        <button className="primary-button create-from-storyboard" type="button" onClick={onCreate} disabled={creating || script.trim().length < 30 || !spec.project_name.trim() || !rootPath.trim()}>{creating ? <><LoaderCircle className="spin" size={18} /> 正在创建项目并解析分镜…</> : <><Sparkles size={18} /> 使用解析结果创建新项目（免费） <ChevronRight size={18} /></>}</button>
      </div>
      {savedTextPath && <small className="storyboard-export-success"><CheckCircle2 size={14} /> 已保存到：{savedTextPath}</small>}
      {exportError && <small className="storyboard-export-error">{exportError}</small>}
    </footer>
  </section>;
}

function VideoRemixPanel({ sourceTask, visualStyles, defaultRootPath, defaultSpec, onProjectCreated }: { sourceTask: DouyinUnderstandingTask; visualStyles: import("@aivs/schemas").VisualStylePreset[]; defaultRootPath: string; defaultSpec: CreationSpec; onProjectCreated: (bundle: ProjectBundle) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [projectName, setProjectName] = useState(`${(sourceTask.title || "视频剧情").trim().slice(0, 48)}·二创`);
  const [creativeDirection, setCreativeDirection] = useState("保留原视频的核心主题、价值立场、关注群体和情绪诉求，在同一主题范围内重构人物身份、场景、事件与表达方式；如原稿包含矛盾升级或反转，则保留其叙事功能。");
  const [originality, setOriginality] = useState<VideoRemixOriginality>("high");
  const [storyboardDurationMode, setStoryboardDurationMode] = useState<VideoRemixStoryboardDurationMode>("fixed");
  const [targetDuration, setTargetDuration] = useState(Math.max(15, Math.min(600, Math.round(sourceTask.duration ?? defaultSpec.target_duration))));
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "16:9">(sourceTask.aspect_ratio === "16:9" || defaultSpec.aspect_ratio === "16:9" ? "16:9" : "9:16");
  const [visualStyle, setVisualStyle] = useState("");
  const [rootPath, setRootPath] = useState(defaultRootPath);
  const remixTasks = useQuery({
    queryKey: ["video-remix-tasks", sourceTask.id],
    queryFn: () => listVideoRemixTasks(sourceTask.id),
    refetchInterval: 1_500,
  });
  const createRemix = useMutation({
    mutationFn: () => createVideoRemixTask({
      source_task_id: sourceTask.id,
      project_name: projectName.trim(),
      creative_direction: creativeDirection.trim(),
      originality,
      storyboard_duration_mode: storyboardDurationMode,
      target_duration: targetDuration,
      aspect_ratio: aspectRatio,
      visual_style: visualStyle,
      language: defaultSpec.language || "zh-CN",
    }),
    onSuccess: () => remixTasks.refetch(),
  });
  const retryRemix = useMutation({
    mutationFn: retryVideoRemixTask,
    onSuccess: () => remixTasks.refetch(),
  });
  const deleteRemix = useMutation({
    mutationFn: deleteVideoRemixTask,
    onSuccess: () => remixTasks.refetch(),
  });
  const saveProject = useMutation({
    mutationFn: (task: VideoRemixTask) => createVideoRemixProject({
      remix_task_id: task.id,
      root_path: rootPath,
      project_name: task.result?.title?.trim() || task.project_name,
    }),
    onSuccess: onProjectCreated,
  });
  const selectRoot = async () => {
    const selected = await chooseProjectDirectory();
    if (selected) setRootPath(selected);
  };
  const activeCount = (remixTasks.data ?? []).filter((task) => task.status === "PENDING" || task.status === "RUNNING").length;
  const canCreate = !createRemix.isPending && projectName.trim().length > 0 && creativeDirection.trim().length >= 4 && targetDuration >= 15 && targetDuration <= 600;
  return <div className={expanded ? "video-remix-inline expanded" : "video-remix-inline"}>
    <div className="video-remix-inline-trigger"><div><strong>二次创作</strong><small>提炼冲突与反转，生成全新剧情和分镜</small></div><button className={expanded ? "secondary-button video-remix-compact-button" : "primary-button video-remix-compact-button"} type="button" onClick={() => setExpanded((value) => !value)}><WandSparkles size={14} />{expanded ? "收起" : "开始二创"}</button></div>
    {expanded && <div className="video-remix-body">
      <ModelCreditNotice capability="TEXT_GENERATION" action="二创" />
      <div className="video-remix-form">
        <label>新项目名称<input value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} /></label>
        <label className="video-remix-direction">二创方向<textarea rows={4} value={creativeDirection} onChange={(event) => setCreativeDirection(event.target.value)} placeholder="例如：保留原稿关怀农民的主题，改用返乡青年经历串联历史贡献，以更具戏剧性的现实故事表达" /><small>默认继承原稿核心主题、价值立场、关注群体和情绪诉求；可以重构人物、场景与事件。只有明确提出更换主题时，AI才会改变主题方向。</small></label>
        <div className="field-grid video-remix-fields">
          <label>原创强度<select value={originality} onChange={(event) => setOriginality(event.target.value as VideoRemixOriginality)}><option value="balanced">平衡改编</option><option value="high">高度原创（推荐）</option><option value="radical">激进原创（强冲突多反转）</option></select></label>
          <label>分镜时长模式<select value={storyboardDurationMode} onChange={(event) => setStoryboardDurationMode(event.target.value as VideoRemixStoryboardDurationMode)}><option value="fixed">固定时长（每镜10秒）</option><option value="adaptive">非固定时长（每镜8～15秒）</option></select></label>
          <label>目标时长<div className="unit-input"><input type="number" min={15} max={600} step={1} value={targetDuration} onChange={(event) => setTargetDuration(Number(event.target.value))} /><span>秒</span></div></label>
          <label>画面比例<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as "9:16" | "16:9")}><option>9:16</option><option>16:9</option></select></label>
          <GroupedVisualStyleSelect value={visualStyle} onChange={setVisualStyle} presets={visualStyles} />
        </div>
        <div className="video-remix-submit-row"><span>生成后会自动检查内容。如需重新生成，会先告诉你要用多少积分，确认后才继续。</span><button className="primary-button" type="button" disabled={!canCreate} onClick={() => { createRemix.reset(); createRemix.mutate(); }}>{createRemix.isPending ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{createRemix.isPending ? "正在创建任务…" : "生成全新剧情与分镜（需积分）"}</button></div>
        {createRemix.error && <div className="error-banner">{readableError(createRemix.error)}</div>}
      </div>
    </div>}
    <div className="video-remix-history video-remix-inline-history">
      <header><div><strong>二创记录</strong><small>结果保存在本机数据库，可关闭程序后继续查看</small></div><span>{activeCount ? `${activeCount} 个生成中` : `${remixTasks.data?.length ?? 0} 条结果`}</span></header>
      {deleteRemix.error && <div className="error-banner">删除二创记录失败：{readableError(deleteRemix.error)}</div>}
      {remixTasks.isLoading ? <div className="video-remix-empty"><LoaderCircle className="spin" size={18} />正在读取二创记录…</div> : remixTasks.error ? <div className="error-banner">{readableError(remixTasks.error)}</div> : (remixTasks.data ?? []).length === 0 ? <div className="video-remix-empty">还没有二创记录，点击上方“开始二创”后创建。</div> : <div className="video-remix-task-list">{(remixTasks.data ?? []).map((task) => <VideoRemixTaskCard key={task.id} task={task} rootPath={rootPath} onRootPathChange={setRootPath} onSelectRoot={() => void selectRoot()} onRetry={() => retryRemix.mutate(task.id)} retrying={retryRemix.isPending && retryRemix.variables === task.id} onDelete={() => { if (window.confirm("确定删除这条二创记录吗？删除后无法恢复。")) deleteRemix.mutate(task.id); }} deleting={deleteRemix.isPending && deleteRemix.variables === task.id} onSave={() => saveProject.mutate(task)} saving={saveProject.isPending && saveProject.variables?.id === task.id} saveError={saveProject.variables?.id === task.id ? saveProject.error : undefined} />)}</div>}
    </div>
  </div>;
}

function VideoRemixTaskCard({ task, rootPath, onRootPathChange, onSelectRoot, onRetry, retrying, onDelete, deleting, onSave, saving, saveError }: { task: VideoRemixTask; rootPath: string; onRootPathChange: (value: string) => void; onSelectRoot: () => void; onRetry: () => void; retrying: boolean; onDelete: () => void; deleting: boolean; onSave: () => void; saving: boolean; saveError?: Error | null }) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const active = task.status === "PENDING" || task.status === "RUNNING";
  const notes = task.result?.adaptation_notes;
  const sourceStructure = runtimeTextList(notes?.source_structure);
  const conflictDesign = runtimeTextList(notes?.conflict_design);
  const reversalDesign = runtimeTextList(notes?.reversal_design);
  const originalityStatement = workflowSummaryText(notes?.originality_statement);
  const shots = Array.isArray(task.result?.canonical?.shots) ? task.result.canonical.shots : [];
  return <article className={`video-remix-task ${task.status.toLowerCase()}`}>
    <header><div><span>{active ? <LoaderCircle className="spin" size={16} /> : task.status === "COMPLETED" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span><div><strong>{workflowSummaryText(task.result?.title, task.project_name)}</strong><small>{task.message} · {task.input.storyboard_duration_mode === "adaptive" ? "非固定8～15秒" : task.input.storyboard_duration_mode === "fixed" ? "固定10秒" : "旧版时长规则"} · {new Date(task.created_at).toLocaleString("zh-CN")}</small></div></div><div className="video-remix-task-header-actions"><em>{Math.round(task.progress * 100)}%</em>{task.status === "COMPLETED" && task.result && <button className="secondary-button" type="button" disabled={deleting} onClick={() => setDetailsExpanded((value) => !value)}>{detailsExpanded ? "收起" : "展开"}<ChevronRight className={detailsExpanded ? "expanded" : ""} size={15} /></button>}<button className="secondary-button danger-button" type="button" disabled={deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{deleting ? "删除中…" : "删除"}</button></div></header>
    {active && <div className="video-remix-progress"><i style={{ width: `${Math.round(task.progress * 100)}%` }} /></div>}
    {task.status === "FAILED" && <div className="video-remix-failed"><span>{task.error?.message || "二次创作失败"}</span><button className="secondary-button" type="button" disabled={retrying || deleting} onClick={onRetry}>{retrying ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{retrying ? "重新加入队列…" : "重试"}</button></div>}
    {detailsExpanded && task.status === "COMPLETED" && task.result && <div className="video-remix-result">
      <div className="video-remix-story"><span>一句话梗概</span><strong>{workflowSummaryText(task.result.logline, "暂未生成一句话梗概")}</strong><p>{workflowSummaryText(task.result.synopsis, "暂未生成剧情梗概")}</p></div>
      <div className="video-remix-design-grid">
        <div><span>结构骨架</span><ul>{sourceStructure.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>
        <div><span>冲突升级</span><ul>{conflictDesign.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>
        <div><span>反转设计</span><ul>{reversalDesign.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>
      </div>
      {originalityStatement && <p className="video-remix-originality"><ShieldCheckIcon />{originalityStatement}</p>}
      <details className="video-remix-shots"><summary>查看全部 {shots.length} 个新分镜</summary><div>{shots.map((shot, index) => { const visual = workflowSummaryText(shot.visual, "未提供具体画面"); const action = workflowSummaryText(shot.action, "未提供具体动作"); const dialogue = workflowSummaryText(shot.dialogue, "无"); return <article key={typeof shot.id === "string" ? shot.id : index}><header><strong>分镜 {index + 1}</strong><span>{workflowSummaryText(shot.duration)}秒 · {workflowSummaryText(shot.shot_size)} · {workflowSummaryText(shot.camera_movement)}</span></header><p><b>画面</b>{visual}</p><p><b>动作</b>{action}</p>{dialogue !== "无" && <p><b>台词</b>{dialogue}</p>}</article>; })}</div></details>
      <label>新项目根目录<div className="path-input"><FolderOpen size={17} /><input value={rootPath} onChange={(event) => onRootPathChange(event.target.value)} /><button type="button" onClick={onSelectRoot}>选择</button></div></label>
      {saveError && <div className="error-banner">{readableError(saveError)}</div>}
      <footer><span>{task.project_path ? `已创建项目：${task.project_path}` : "确认结果后保存为独立本地项目，原解析任务不会改变。"}</span><button className="primary-button" type="button" disabled={saving || deleting || !rootPath.trim()} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}{saving ? "正在保存新项目…" : task.project_path ? "再次保存为新项目（免费）" : "保存为新项目（免费）"}</button></footer>
    </div>}
  </article>;
}

function ShieldCheckIcon() {
  return <CheckCircle2 size={15} />;
}

function ProjectCenterPanel({ projects, loading, loadingProjectId, onRefresh, onOpen, onDelete }: { projects: ProjectListItem[]; loading: boolean; loadingProjectId?: string; onRefresh: () => void; onOpen: (project: ProjectListItem) => void; onDelete: (project: ProjectListItem) => void }) {
  const visibleProjects = projects.filter((project) => !project.is_example);
  return <section className="project-center-panel">
    <div className="project-center-toolbar"><span>{loading ? "正在读取本地项目…" : `共 ${visibleProjects.length} 个本地项目`}</span><button className="secondary-button toolbar-button" type="button" onClick={onRefresh} disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}刷新</button></div>
    <div className="project-list project-center-list">{loading && visibleProjects.length === 0 ? <div className="project-center-empty"><LoaderCircle className="spin" size={24} /><span>正在加载项目…</span></div> : visibleProjects.length === 0 ? <div className="project-center-empty"><FolderOpen size={32} /><strong>还没有已创建的项目</strong><span>可从左侧其他创建方式建立第一个本地项目。</span></div> : visibleProjects.map((project) => <article className="project-center-row" key={project.id}><button className="project-list-item" onClick={() => onOpen(project)} disabled={Boolean(loadingProjectId)}><div className="project-list-icon"><Clapperboard size={20} /></div><div><div className="project-list-title"><strong>{project.name}</strong></div><small>{project.input_type} · {project.status} · {new Date(project.updated_at).toLocaleString("zh-CN")}</small><em>{project.project_path}</em></div><ChevronRight size={18} />{loadingProjectId === project.id && <LoaderCircle className="spin project-loading" size={18} />}</button><button className="project-delete-button" type="button" aria-label={`删除项目 ${project.name}`} title="删除项目" onClick={() => onDelete(project)} disabled={Boolean(loadingProjectId)}><Trash2 size={17} /><span>删除</span></button></article>)}</div>
  </section>;
}

function DeleteProjectConfirmModal({ project, deleting, error, onCancel, onConfirm }: { project: ProjectListItem; deleting: boolean; error: unknown; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(<div className="modal-backdrop project-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
    <section className="project-delete-modal" role="dialog" aria-modal="true" aria-labelledby="project-delete-title">
      <header><div className="project-delete-icon"><AlertTriangle size={23} /></div><div><h2 id="project-delete-title">确认删除整个项目？</h2><p>此操作将永久删除项目数据以及该项目生成的视频文件。</p></div><button className="modal-close" type="button" aria-label="关闭删除确认" onClick={onCancel} disabled={deleting}><X size={18} /></button></header>
      <div className="project-delete-body"><strong>{project.name}</strong><span>{project.project_path}</span><div className="project-delete-preserve"><Images size={18} /><div><b>场景图和角色图会保留</b><small>删除开始前会先写入独立资产库，之后仍可在“资产库”中查看。</small></div></div>{Boolean(error) && <div className="error-banner">{readableError(error)}</div>}</div>
      <footer><button className="secondary-button" type="button" onClick={onCancel} disabled={deleting}>取消</button><button className="danger-button project-delete-confirm" type="button" onClick={onConfirm} disabled={deleting}>{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}{deleting ? "正在同步资产并删除…" : "确认删除整个项目"}</button></footer>
    </section>
  </div>, document.body);
}

type AssetLibraryFilter = "all" | AssetLibraryItem["asset_type"];

const assetLibraryTabs: Array<{ type: AssetLibraryFilter; label: string }> = [
  { type: "all", label: "全部" },
  { type: "scene", label: "场景" },
  { type: "character", label: "角色" },
  { type: "prop", label: "道具" },
];

function assetTypeLabel(type: AssetLibraryItem["asset_type"]) {
  return assetLibraryTabs.find((tab) => tab.type === type)?.label ?? "资产";
}

function AssetLibraryDetailModal({ asset, onClose }: { asset: AssetLibraryItem; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const copyPrompt = async () => {
    await navigator.clipboard.writeText(asset.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return createPortal(<div className="modal-backdrop asset-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="asset-detail-modal" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title">
      <header><div><span>{assetTypeLabel(asset.asset_type)}</span><h2 id="asset-detail-title">{asset.name}</h2></div><button className="modal-close" type="button" aria-label="关闭资产详情" onClick={onClose}><X size={18} /></button></header>
      <div className="asset-detail-content">
        <div className="asset-detail-image"><img src={convertFileSrc(asset.image_path)} alt={asset.name} /></div>
        <section className="asset-detail-prompt"><div><strong>生成提示词</strong><button className={copied ? "prompt-copy-button copied" : "prompt-copy-button"} type="button" onClick={copyPrompt}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制提示词"}</button></div><p>{asset.prompt || "暂无提示词"}</p></section>
      </div>
      <footer><span>创建于 {new Date(asset.created_at).toLocaleString("zh-CN")}</span><button className="secondary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}

function DeleteAssetsConfirmModal({ count, deleting, error, onCancel, onConfirm }: { count: number; deleting: boolean; error: unknown; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(<div className="modal-backdrop project-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
    <section className="project-delete-modal asset-delete-modal" role="dialog" aria-modal="true" aria-labelledby="asset-delete-title">
      <header><div className="project-delete-icon"><Trash2 size={23} /></div><div><h2 id="asset-delete-title">确认删除选中的 {count} 项资产？</h2><p>此操作会永久删除资产库中的数据记录和图片文件。</p></div><button className="modal-close" type="button" aria-label="关闭资产删除确认" onClick={onCancel} disabled={deleting}><X size={18} /></button></header>
      <div className="project-delete-body"><div className="asset-delete-warning"><AlertTriangle size={18} /><div><b>删除后无法恢复</b><small>项目目录中的原始场景图和角色图不会被删除，且已删除资产不会在下次启动时被自动重新导入。</small></div></div>{Boolean(error) && <div className="error-banner">{readableError(error)}</div>}</div>
      <footer><button className="secondary-button" type="button" onClick={onCancel} disabled={deleting}>取消</button><button className="danger-button project-delete-confirm" type="button" onClick={onConfirm} disabled={deleting}>{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}{deleting ? "正在删除资产和图片…" : `确认删除 ${count} 项资产`}</button></footer>
    </section>
  </div>, document.body);
}

function AssetLibraryPanel({ assets, loading, error, onRefresh }: { assets: AssetLibraryItem[]; loading: boolean; error: unknown; onRefresh: () => void }) {
  const [activeType, setActiveType] = useState<AssetLibraryFilter>("all");
  const [selectedAsset, setSelectedAsset] = useState<AssetLibraryItem>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const filteredAssets = activeType === "all" ? assets : assets.filter((asset) => asset.asset_type === activeType);
  const activeLabel = assetLibraryTabs.find((tab) => tab.type === activeType)?.label ?? "全部";
  const allFilteredSelected = filteredAssets.length > 0 && filteredAssets.every((asset) => selectedIds.has(asset.id));
  const deleteAssets = useMutation({
    mutationFn: (ids: string[]) => deleteAssetLibrary(ids),
    onSuccess: () => {
      setShowDeleteConfirm(false);
      setSelectionMode(false);
      setSelectedIds(new Set());
      onRefresh();
    },
  });
  useEffect(() => {
    const availableIds = new Set(assets.map((asset) => asset.id));
    setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [assets]);
  const toggleAsset = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds((current) => {
    const next = new Set(current);
    if (allFilteredSelected) filteredAssets.forEach((asset) => next.delete(asset.id));
    else filteredAssets.forEach((asset) => next.add(asset.id));
    return next;
  });
  const cancelSelection = () => {
    deleteAssets.reset();
    setShowDeleteConfirm(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  return <>
    <section className="asset-library-panel">
      <div className="project-center-toolbar"><span>{loading ? "正在读取资产库…" : `共 ${assets.length} 项资产`}</span><button className="secondary-button toolbar-button" type="button" onClick={onRefresh} disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}刷新</button></div>
      {Boolean(error) && <div className="error-banner">{readableError(error)}</div>}
      <div className="asset-library-tab-row"><nav className="asset-library-tabs" role="tablist" aria-label="资产类型">
          {assetLibraryTabs.map((tab) => { const count = tab.type === "all" ? assets.length : assets.filter((asset) => asset.asset_type === tab.type).length; return <button key={tab.type} className={activeType === tab.type ? "active" : ""} type="button" role="tab" aria-selected={activeType === tab.type} onClick={() => setActiveType(tab.type)}><span>{tab.label}</span><b>{count}</b></button>; })}
        </nav><div className="asset-library-batch-actions">{selectionMode ? <><span className="asset-selected-count">已选 {selectedIds.size} 项</span><button className="secondary-button toolbar-button" type="button" onClick={toggleAll} disabled={filteredAssets.length === 0}>{allFilteredSelected ? "取消全选" : "全选"}</button><button className="secondary-button toolbar-button" type="button" onClick={cancelSelection}>取消</button><button className="danger-button asset-batch-delete-confirm" type="button" disabled={selectedIds.size === 0} onClick={() => { deleteAssets.reset(); setShowDeleteConfirm(true); }}><Trash2 size={14} />删除所选</button></> : <button className="secondary-button toolbar-button asset-batch-delete-entry" type="button" onClick={() => { deleteAssets.reset(); setSelectionMode(true); }} disabled={assets.length === 0}><Trash2 size={14} />批量删除</button>}</div></div>
      {loading && assets.length === 0 ? <div className="asset-library-empty"><LoaderCircle className="spin" size={20} />加载中…</div> : filteredAssets.length === 0 ? <div className="asset-library-empty">暂无{activeLabel === "全部" ? "资产" : `${activeLabel}资产`}</div> : <div className="asset-library-masonry">
        {filteredAssets.map((asset) => { const selected = selectedIds.has(asset.id); return <button className={`asset-library-card${selectionMode ? " selecting" : ""}${selected ? " selected" : ""}`} type="button" key={asset.id} onClick={() => selectionMode ? toggleAsset(asset.id) : setSelectedAsset(asset)} aria-label={selectionMode ? `${selected ? "取消选择" : "选择"}资产 ${asset.name}` : `查看资产 ${asset.name}`} aria-pressed={selectionMode ? selected : undefined}>{selectionMode && <span className="asset-selection-check">{selected && <Check size={13} />}</span>}<span className="asset-library-image"><img src={convertFileSrc(asset.image_path)} alt={asset.name} /></span><span className="asset-library-card-copy"><strong>{asset.name}</strong><span>{asset.prompt || "暂无提示词"}</span></span></button>; })}
      </div>}
    </section>
    {selectedAsset && <AssetLibraryDetailModal asset={selectedAsset} onClose={() => setSelectedAsset(undefined)} />}
    {showDeleteConfirm && <DeleteAssetsConfirmModal count={selectedIds.size} deleting={deleteAssets.isPending} error={deleteAssets.error} onCancel={() => { if (!deleteAssets.isPending) { deleteAssets.reset(); setShowDeleteConfirm(false); } }} onConfirm={() => deleteAssets.mutate([...selectedIds])} />}
  </>;
}

function StoryboardModeModal({ onClose, onSelect }: { onClose: () => void; onSelect: (selection: StoryboardUnderstandingSelection) => void }) {
  const [selectedMode, setSelectedMode] = useState<StoryboardUnderstandingMode>("standard");
  const [fixedSeconds, setFixedSeconds] = useState<FixedStoryboardSeconds>(10);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="storyboard-mode-modal" role="dialog" aria-modal="true" aria-labelledby="storyboard-mode-title">
      <header><div><span className="eyebrow">VIDEO UNDERSTANDING MODE</span><h2 id="storyboard-mode-title">选择视频理解模式</h2><p>三种模式都会输出可查看、可编辑并可直接创建项目的结构化分镜。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="storyboard-mode-options">
        <button className={`storyboard-mode-option recommended${selectedMode === "standard" ? " active" : ""}`} type="button" onClick={() => setSelectedMode("standard")} aria-pressed={selectedMode === "standard"}>
          <span className="mode-icon"><Sparkles size={22} /></span><span className="mode-copy"><span className="mode-title"><strong>标准模式</strong><em>推荐</em></span><small>使用默认视频理解提示词，按 10～15 秒组织分镜，速度与信息密度更均衡。</small></span>{selectedMode === "standard" ? <CheckCircle2 size={20} /> : <ChevronRight size={20} />}
        </button>
        <button className={`storyboard-mode-option${selectedMode === "detailed" ? " active" : ""}`} type="button" onClick={() => setSelectedMode("detailed")} aria-pressed={selectedMode === "detailed"}>
          <span className="mode-icon"><ScanSearch size={22} /></span><span className="mode-copy"><span className="mode-title"><strong>详细模式</strong></span><small>进一步把每个分镜的画面按内容节奏细分到秒，逐段写明运镜，并把台词放入对应画面。</small></span>{selectedMode === "detailed" ? <CheckCircle2 size={20} /> : <ChevronRight size={20} />}
        </button>
        <section className={`storyboard-mode-option fixed-duration-mode${selectedMode === "fixed" ? " active" : ""}`} role="button" tabIndex={0} aria-pressed={selectedMode === "fixed"} onClick={() => setSelectedMode("fixed")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedMode("fixed"); } }}>
          <span className="mode-icon"><Clapperboard size={22} /></span><span className="mode-copy"><span className="mode-title"><strong>固定秒数模式</strong></span><small>除最后一段外，所有分镜严格使用相同的固定时长。</small><label className="fixed-duration-select">每个分镜<select value={fixedSeconds} onChange={(event) => { setFixedSeconds(Number(event.target.value) as FixedStoryboardSeconds); setSelectedMode("fixed"); }}><option value={10}>10 秒（默认）</option><option value={15}>15 秒</option><option value={6}>6 秒</option></select></label></span>{selectedMode === "fixed" ? <CheckCircle2 size={20} /> : <ChevronRight size={20} />}
        </section>
      </div>
      <footer><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button storyboard-mode-confirm" type="button" onClick={() => onSelect({ mode: selectedMode, fixedSeconds: selectedMode === "fixed" ? fixedSeconds : undefined })}><ScanSearch size={17} />确定开始分析</button></footer>
    </section>
  </div>, document.body);
}

const generationStatusLabels: Record<GenerationRecord["status"], string> = {
  PENDING: "等待生成", RUNNING: "正在生成", REMOTE_PROCESSING: "模型处理中", DOWNLOADING: "正在下载", COMPLETED: "已完成", FAILED: "生成失败",
};

function GenerationRecordPreview({ projectPath, record }: { projectPath: string; record: GenerationRecord }) {
  const asset = useQuery({
    queryKey: ["generation-record-asset", projectPath, record.result_relative_path],
    queryFn: () => readProjectAsset(projectPath, record.result_relative_path!),
    enabled: record.status === "COMPLETED" && Boolean(record.result_relative_path),
    staleTime: Infinity,
  });
  if (asset.data) return record.media_type === "image"
    ? <img src={asset.data} alt={`${record.target_id} 生成图片`} />
    : <video src={asset.data} controls preload="metadata" />;
  if (asset.isLoading) return <div className="generation-record-placeholder"><LoaderCircle className="spin" size={28} /><span>读取本地文件…</span></div>;
  return <div className={record.status === "FAILED" ? "generation-record-placeholder failed" : "generation-record-placeholder"}>
    {record.status === "FAILED" ? <AlertTriangle size={30} /> : record.media_type === "image" ? <ImageIcon size={32} /> : <Clapperboard size={32} />}
    <span>{generationStatusLabels[record.status]}</span>
  </div>;
}

function GenerationRecordsModal({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const recordsQuery = useProjectGenerationRecords(projectPath);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [exportingRecordId, setExportingRecordId] = useState("");
  const [exportingAll, setExportingAll] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const records = (recordsQuery.data ?? []).filter((record) => filter === "all" || record.media_type === filter);
  const completedCount = (recordsQuery.data ?? []).filter((record) => record.status === "COMPLETED" && Boolean(record.result_relative_path)).length;
  const saveRecord = async (record: GenerationRecord) => {
    setExportingRecordId(record.id); setExportMessage(""); setExportError("");
    try {
      const path = await saveGenerationRecordAsset(projectPath, record);
      if (path) setExportMessage(`已保存：${path}`);
    } catch (error) { setExportError(readableError(error)); }
    finally { setExportingRecordId(""); }
  };
  const saveAll = async () => {
    setExportingAll(true); setExportMessage(""); setExportError("");
    try {
      const result = await exportAllGenerationAssets(projectPath);
      if (result) setExportMessage(`已保存 ${result.exported_files.length} 个文件${result.skipped_count ? `，跳过 ${result.skipped_count} 条未完成或缺失记录` : ""}：${result.output_directory}`);
    } catch (error) { setExportError(readableError(error)); }
    finally { setExportingAll(false); }
  };
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="generation-records-modal" role="dialog" aria-modal="true" aria-labelledby="generation-records-title">
      <header><div><span className="eyebrow">GENERATION HISTORY</span><h2 id="generation-records-title">生成记录</h2><p>查看当前项目全部图片与视频生成流水，以及保存在本地的结果文件。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="generation-record-filters">
        <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>全部 <span>{recordsQuery.data?.length ?? 0}</span></button>
        <button className={filter === "image" ? "active" : ""} type="button" onClick={() => setFilter("image")}><ImageIcon size={15} /> 图片 <span>{recordsQuery.data?.filter((item) => item.media_type === "image").length ?? 0}</span></button>
        <button className={filter === "video" ? "active" : ""} type="button" onClick={() => setFilter("video")}><Clapperboard size={15} /> 视频 <span>{recordsQuery.data?.filter((item) => item.media_type === "video").length ?? 0}</span></button>
        <span className={exportError ? "generation-record-export-message error" : "generation-record-export-message"}>{exportError || exportMessage}</span>
        <button className="generation-record-export-all" type="button" onClick={saveAll} disabled={exportingAll || completedCount === 0}>{exportingAll ? <LoaderCircle className="spin" size={15} /> : <FileDown size={15} />}{exportingAll ? "正在保存…" : "一键保存全部"}</button>
      </div>
      <div className="generation-records-body">
        {recordsQuery.isLoading ? <div className="settings-loading"><LoaderCircle className="spin" /> 正在读取生成记录…</div> : recordsQuery.error ? <div className="error-banner">{readableError(recordsQuery.error)}</div> : records.length === 0 ? <div className="generation-records-empty"><History size={38} /><strong>暂无生成记录</strong><span>角色图、场景图、分镜图和分镜视频的生成流水会显示在这里。</span></div> : <div className="generation-records-grid">{records.map((record) => <article className="generation-record-card" key={record.id}>
          <div className="generation-record-media"><GenerationRecordPreview projectPath={projectPath} record={record} /><span className={`generation-record-status ${record.status.toLowerCase()}`}>{generationStatusLabels[record.status]}</span></div>
          <div className="generation-record-info"><div className="generation-record-title"><strong>{record.target_type === "project" ? "项目合成视频" : record.target_id}</strong><span>{record.media_type === "image" ? "图片" : "视频"} · {record.target_type === "character" ? "角色" : record.target_type === "scene" ? "场景" : record.target_type === "project" ? "项目" : "分镜"}</span></div><small>{record.model} · {record.aspect_ratio} · {new Date(record.created_at).toLocaleString("zh-CN")}</small><div className="generation-record-progress"><i style={{ width: `${Math.max(0, Math.min(100, record.progress * 100))}%` }} /></div>{record.error?.message && <p className="generation-record-error">{record.error.message}</p>}<details><summary>查看生成提示词</summary><p>{record.prompt}</p></details><div className="generation-record-card-actions"><button type="button" onClick={() => saveRecord(record)} disabled={exportingRecordId === record.id || record.status !== "COMPLETED" || !record.result_relative_path}>{exportingRecordId === record.id ? <LoaderCircle className="spin" size={14} /> : <FileDown size={14} />}{exportingRecordId === record.id ? "正在保存…" : "另存为"}</button></div></div>
        </article>)}</div>}
      </div>
      <footer><button className="secondary-button" type="button" onClick={() => recordsQuery.refetch()} disabled={recordsQuery.isFetching}>{recordsQuery.isFetching ? <LoaderCircle className="spin" size={16} /> : <History size={16} />} 刷新</button><button className="primary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}

type ApplicationLogFilter = "all" | ApplicationLogLevel;

const applicationLogLevelLabels: Record<ApplicationLogLevel, string> = {
  critical: "Critical",
  error: "Error",
  info: "Info",
  debug: "Debug",
};

function localDateTimeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function applicationLogDetailsText(entry: ApplicationLogEntry): string {
  return JSON.stringify(entry.details, null, 2);
}

function applicationLogExportText(entries: ApplicationLogEntry[], filter: ApplicationLogFilter, start: Date, end: Date, truncated: boolean): string {
  const header = [
    "AI Video Studio 应用日志",
    `时间范围：${start.toLocaleString("zh-CN", { hour12: false })} ～ ${end.toLocaleString("zh-CN", { hour12: false })}`,
    `日志等级：${filter === "all" ? "全部" : applicationLogLevelLabels[filter]}`,
    `记录数量：${entries.length}${truncated ? "（达到导出上限，较早记录未包含）" : ""}`,
    "",
  ];
  const body = entries.flatMap((entry) => [
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.event}`,
    applicationLogDetailsText(entry),
    "",
  ]);
  return [...header, ...body].join("\n");
}

function ApplicationLogsModal({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<ApplicationLogFilter>("all");
  const [rangeStart, setRangeStart] = useState(() => localDateTimeInputValue(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [rangeEnd, setRangeEnd] = useState(() => localDateTimeInputValue(new Date()));
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState(false);
  const [copiedEntryKey, setCopiedEntryKey] = useState("");
  const logs = useQuery({
    queryKey: ["application-logs", filter],
    queryFn: () => listApplicationLogs(filter),
  });
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const filters: Array<[ApplicationLogFilter, string]> = [["all", "全部"], ["critical", "Critical"], ["error", "Error"], ["info", "Info"], ["debug", "Debug"]];
  const copyDetails = async (entry: ApplicationLogEntry, key: string) => {
    try {
      await navigator.clipboard.writeText(applicationLogDetailsText(entry));
      setCopiedEntryKey(key);
      setFeedbackError(false);
      setFeedback("日志详情已复制到剪贴板");
      window.setTimeout(() => setCopiedEntryKey((current) => current === key ? "" : current), 1800);
    } catch (error) {
      setFeedbackError(true);
      setFeedback(`复制失败：${readableError(error)}`);
    }
  };
  const exportLogs = async () => {
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);
    if (!rangeStart || !rangeEnd || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setFeedbackError(true);
      setFeedback("请选择有效的开始时间和结束时间");
      return;
    }
    if (start > end) {
      setFeedbackError(true);
      setFeedback("开始时间不能晚于结束时间");
      return;
    }
    setExporting(true);
    setFeedback("");
    setFeedbackError(false);
    try {
      const rangedLogs = await listApplicationLogs(filter, {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        limit: 100_000,
      });
      if (!rangedLogs.entries.length) {
        setFeedbackError(true);
        setFeedback("所选时间段内没有符合当前等级筛选的日志");
        return;
      }
      const fileRange = `${rangeStart.replace(/[T:]/g, "-")}_${rangeEnd.replace(/[T:]/g, "-")}`;
      const savedPath = await saveTextAsTxt(
        applicationLogExportText(rangedLogs.entries, filter, start, end, rangedLogs.truncated),
        `AI_Video_Studio_日志_${fileRange}.txt`,
      );
      if (savedPath) {
        setFeedbackError(false);
        setFeedback(`已导出 ${rangedLogs.entries.length} 条日志：${savedPath}`);
      }
    } catch (error) {
      setFeedbackError(true);
      setFeedback(`日志导出失败：${readableError(error)}`);
    } finally {
      setExporting(false);
    }
  };
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="application-logs-modal" role="dialog" aria-modal="true" aria-labelledby="application-logs-title">
      <header><div><span className="eyebrow">APPLICATION LOGS</span><h2 id="application-logs-title">应用日志</h2><p>按等级查看应用运行、接口请求及错误详情。API Key 和参考图原始数据不会写入日志。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭日志"><X size={18} /></button></header>
      <div className="application-log-toolbar"><div className="application-log-filters">{filters.map(([value, label]) => <button className={filter === value ? `active ${value}` : value} type="button" key={value} onClick={() => setFilter(value)}>{label}</button>)}</div><span title={logs.data?.directory}>{logs.data?.directory || "正在读取日志目录…"}</span></div>
      <div className="application-log-export-toolbar"><label><span>开始时间</span><input type="datetime-local" step="1" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label><label><span>结束时间</span><input type="datetime-local" step="1" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label><button className="secondary-button" type="button" onClick={() => void exportLogs()} disabled={exporting}>{exporting ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}{exporting ? "正在导出…" : "按时间段另存为 TXT"}</button></div>
      <div className="application-log-body">
        {logs.isLoading ? <div className="settings-loading"><LoaderCircle className="spin" /> 正在读取日志…</div> : logs.error ? <div className="error-banner">{readableError(logs.error)}</div> : !logs.data?.entries.length ? <div className="application-log-empty"><ScrollText size={38} /><strong>该分类暂无日志</strong><span>后续符合该等级的日志会显示在这里。</span></div> : <div className="application-log-list">{logs.data.entries.map((entry, index) => { const entryKey = `${entry.timestamp}-${entry.event}-${index}`; return <article className={`application-log-entry ${entry.level}`} key={entryKey}><header><span className={`application-log-level ${entry.level}`}>{applicationLogLevelLabels[entry.level]}</span><strong>{entry.event}</strong><time>{new Date(entry.timestamp).toLocaleString("zh-CN", { hour12: false })}</time></header><details><summary>查看详情</summary><div className="application-log-detail-actions"><span>JSON 详情</span><button type="button" onClick={() => void copyDetails(entry, entryKey)}><Copy size={14} />{copiedEntryKey === entryKey ? "已复制" : "一键复制"}</button></div><pre>{applicationLogDetailsText(entry)}</pre></details></article>; })}</div>}
      </div>
      <footer><div className={feedbackError ? "application-log-feedback error" : "application-log-feedback"}>{feedback || (logs.data?.truncated ? `日志较多，当前显示最近 ${logs.data.entries.length} 条` : "")}</div><button className="secondary-button" type="button" onClick={() => logs.refetch()} disabled={logs.isFetching}>{logs.isFetching ? <LoaderCircle className="spin" size={16} /> : <History size={16} />}刷新</button><button className="primary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}

function ProjectVideoPlayerModal({ projectPath, record, aspectRatio, shotCount, onClose }: { projectPath: string; record: GenerationRecord; aspectRatio: string; shotCount: number; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const relativePath = record.result_relative_path!;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const saveAs = async () => {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const outputPath = await saveGenerationRecordAsset(projectPath, record);
      if (outputPath) setSaveMessage(`已保存：${outputPath}`);
    } catch (error) {
      setSaveError(readableError(error));
    } finally {
      setSaving(false);
    }
  };
  return createPortal(<div className="modal-backdrop project-video-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-video-modal" role="dialog" aria-modal="true" aria-labelledby="project-video-modal-title">
      <header><div><span className="eyebrow">COMPOSED PROJECT VIDEO</span><h2 id="project-video-modal-title">合成视频</h2><p>{aspectRatio} · {shotCount} 个分镜 · 已保存到项目本地目录</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭合成视频"><X size={18} /></button></header>
      <div className="project-video-modal-player"><ShotGeneratedMedia projectPath={projectPath} relativePath={relativePath} mediaType="video" /></div>
      <footer><span className={saveError ? "project-video-save-message error" : "project-video-save-message"}>{saveError || saveMessage || "可直接播放、暂停、调整进度和进入全屏模式"}</span><div className="project-video-modal-actions"><button className="secondary-button" type="button" onClick={() => void saveAs()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}{saving ? "正在保存…" : "另存为"}</button><button className="primary-button" type="button" onClick={onClose}>关闭</button></div></footer>
    </section>
  </div>, document.body);
}

type AutoProjectMode = "fast" | "storyboard";
type AutoProjectStage = AutomaticWorkflowStage;

interface AutoProjectWorkflowState {
  id?: string;
  visible: boolean;
  running: boolean;
  cancelled?: boolean;
  mode: AutoProjectMode;
  resolution: string;
  stage: AutoProjectStage;
  message: string;
  retryMessage: string;
  imageTasks: ImageGenerationTask[];
  records: GenerationRecord[];
}

const workflowWait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function autoWorkflowResolutions(model?: string): string[] {
  const resolutions = videoResolutionOptions(model, "标准");
  return resolutions.length ? resolutions : ["default"];
}

function workflowCreditResolution(value: string): VideoCreditResolution {
  return (["480p", "720p", "768P", "1080p", "2K", "4K"] as string[]).includes(value) ? value as VideoCreditResolution : "default";
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}



function workflowTaskStatus(task: ImageGenerationTask | GenerationRecord | undefined, ready: boolean, pendingText: string) {
  if (ready) return { label: "已完成", progress: 1, className: "completed" };
  if (!task) return { label: pendingText, progress: 0, className: "pending" };
  return { label: generationStatusLabels[task.status], progress: task.progress, className: task.status.toLowerCase() };
}

function currentProjectComposition(records: GenerationRecord[]): GenerationRecord | undefined {
  const composition = records.find((record) => record.media_type === "video" && record.target_type === "project" && record.status === "COMPLETED" && record.result_relative_path);
  if (!composition) return undefined;
  const latestShotVideoCreatedAt = records
    .filter((record) => record.media_type === "video" && record.target_type === "shot" && record.status === "COMPLETED" && record.result_relative_path)
    .reduce((latest, record) => record.created_at > latest ? record.created_at : latest, "");
  return !latestShotVideoCreatedAt || composition.created_at >= latestShotVideoCreatedAt ? composition : undefined;
}

function automaticWorkflowSnapshot(canonical: CanonicalProject, mode: AutoProjectMode, imageTasks: ImageGenerationTask[], records: GenerationRecord[]): AutomaticWorkflowTaskSnapshot[] {
  const imageItem = (targetType: "scene" | "character" | "character_state" | "shot", targetId: string, fallbackPath?: string): AutomaticWorkflowTaskSnapshot => {
    const task = latestTargetTask(imageTasks, targetType, targetId);
    const path = latestTargetImage(imageTasks, targetType, targetId) ?? fallbackPath;
    return {
      id: task?.id ?? `PENDING_IMAGE_${targetType}_${targetId}`,
      media_type: "image",
      target_type: targetType,
      target_id: targetId,
      status: path ? "COMPLETED" : task?.status ?? "PENDING",
      progress: path ? 1 : task?.progress ?? 0,
      result_relative_path: path,
      error: task?.error,
    };
  };
  const videoItem = (shot: Shot): AutomaticWorkflowTaskSnapshot => {
    const record = records.find((item) => item.media_type === "video" && item.target_type === "shot" && item.target_id === shot.id);
    const path = record?.result_relative_path ?? firstProjectAsset(shot.video_assets);
    return {
      id: record?.id ?? `PENDING_VIDEO_shot_${shot.id}`,
      media_type: "video",
      target_type: "shot",
      target_id: shot.id,
      status: path ? "COMPLETED" : record?.status ?? "PENDING",
      progress: path ? 1 : record?.progress ?? 0,
      result_relative_path: path,
      error: record?.error,
    };
  };
  const currentComposition = currentProjectComposition(records);
  const compositionRecord = currentComposition ?? records.find((item) => item.media_type === "video" && item.target_type === "project" && item.status !== "COMPLETED");
  const compositionItem: AutomaticWorkflowTaskSnapshot = {
    id: compositionRecord?.id ?? "PENDING_VIDEO_project_composition",
    media_type: "video",
    target_type: "project",
    target_id: "project-composition",
    status: currentComposition?.result_relative_path ? "COMPLETED" : compositionRecord?.status ?? "PENDING",
    progress: currentComposition?.result_relative_path ? 1 : compositionRecord?.progress ?? 0,
    result_relative_path: currentComposition?.result_relative_path,
    error: compositionRecord?.error,
  };
  return [
    ...canonical.scenes.map((scene) => imageItem("scene", scene.id, firstProjectAsset(scene.reference_assets))),
    ...canonical.characters.flatMap((character) => characterStates(character).map((state) => imageItem("character_state", state.id, firstProjectAsset(state.reference_assets) ?? firstProjectAsset(character.reference_assets)))),
    ...(mode === "storyboard" ? canonical.shots.map((shot) => imageItem("shot", shot.id, firstProjectAsset(shot.reference_assets))) : []),
    ...canonical.shots.map(videoItem),
    compositionItem,
  ];
}

function automaticWorkflowProgress(items: AutomaticWorkflowTaskSnapshot[]): number {
  return items.length ? items.reduce((sum, item) => sum + item.progress, 0) / items.length : 1;
}

function AutoProjectWorkflowModal({ canonical, projectPath, state, stopping, onStop, onClose }: { canonical: CanonicalProject; projectPath: string; state: AutoProjectWorkflowState; stopping: boolean; onStop: () => void; onClose: () => void }) {
  const [showComposedVideo, setShowComposedVideo] = useState(false);
  const sceneRows = canonical.scenes.map((scene) => { const task = latestTargetTask(state.imageTasks, "scene", scene.id); const path = preferredProjectAsset(scene.reference_assets, latestTargetImage(state.imageTasks, "scene", scene.id)); return { id: scene.id, name: scene.name, task, path, ...workflowTaskStatus(task, Boolean(path), "等待启动") }; });
  const characterRows = canonical.characters.flatMap((character) => characterStates(character).map((characterState) => { const task = latestTargetTask(state.imageTasks, "character_state", characterState.id); const path = characterStateImage(character, characterState, state.imageTasks); return { id: characterState.id, name: character.name + " · " + characterState.name, task, path, ...workflowTaskStatus(task, Boolean(path), "等待启动") }; }));
  const shotImageRows = canonical.shots.map((shot) => { const task = latestTargetTask(state.imageTasks, "shot", shot.id); const path = latestTargetImage(state.imageTasks, "shot", shot.id) ?? firstProjectAsset(shot.reference_assets); const skipped = state.mode === "fast"; return { id: shot.id, name: shot.visual || shot.action, task, path, ...(skipped ? { label: "快速模式跳过", progress: 1, className: "skipped" } : workflowTaskStatus(task, Boolean(path), state.stage === "assets" ? "等待资产完成" : "等待启动")) }; });
  const videoRows = canonical.shots.map((shot) => { const record = state.records.find((item) => item.media_type === "video" && item.target_type === "shot" && item.target_id === shot.id); const path = record?.status === "COMPLETED" ? record.result_relative_path : firstProjectAsset(shot.video_assets); return { id: shot.id, name: shot.visual || shot.action, record, path, ...workflowTaskStatus(record, Boolean(path), ["assets", "storyboard"].includes(state.stage) ? "等待前置步骤" : "等待启动") }; });
  const currentComposition = currentProjectComposition(state.records);
  const compositionRecord = currentComposition ?? state.records.find((item) => item.media_type === "video" && item.target_type === "project" && item.status !== "COMPLETED");
  const compositionPath = currentComposition?.result_relative_path;
  const compositionRow = { id: "PROJECT_VIDEO", name: "项目完整合成视频", record: compositionRecord, path: compositionPath, ...workflowTaskStatus(compositionRecord, Boolean(compositionPath), state.stage === "composition" ? "准备合成" : "等待全部分镜视频") };
  const allRows = [...sceneRows, ...characterRows, ...(state.mode === "storyboard" ? shotImageRows : []), ...videoRows, compositionRow];
  const overall = allRows.length ? allRows.reduce((sum, row) => sum + row.progress, 0) / allRows.length : 1;
  const renderImageRow = (row: typeof sceneRows[number]) => <article className={`auto-workflow-task ${row.className}`} key={row.id}><div className="auto-workflow-preview">{row.path ? <ProjectAssetPreview projectPath={projectPath} relativePath={row.path} fallback={<ImageIcon size={22} />} /> : <ImageIcon size={22} />}</div><div><strong>{row.id} · {row.name}</strong><span>{row.task?.error?.message || row.label}</span></div><i title="制作阶段，并非实际生成百分比"><b style={{ width: `${row.progress * 100}%` }} /></i><em>{row.path ? "100%" : row.task?.status === "FAILED" ? "失败" : activeImageTask(row.task) ? <LoaderCircle className="spin" size={15} aria-label="生成中" /> : "—"}</em></article>;
  const renderVideoRow = (row: typeof videoRows[number]) => <article className={`auto-workflow-task video ${row.className}`} key={row.id}><div className="auto-workflow-preview">{row.path ? <ShotGeneratedMedia projectPath={projectPath} relativePath={row.path} mediaType="video" /> : <Clapperboard size={22} />}</div><div><strong>{row.id}</strong><span>{row.record?.error?.message || row.label}</span></div><i><b style={{ width: `${row.progress * 100}%` }} /></i><em>{Math.round(row.progress * 100)}%</em></article>;
  const renderCompositionRow = <article className={`auto-workflow-task video composition ${compositionRow.className}`}><div className="auto-workflow-preview">{compositionPath ? <ShotGeneratedMedia projectPath={projectPath} relativePath={compositionPath} mediaType="video" /> : <Clapperboard size={22} />}</div><div><strong>{compositionRow.name}</strong><span>{compositionRecord?.error?.message || compositionRow.label}</span>{compositionPath && <button className="auto-workflow-play-button" type="button" onClick={() => setShowComposedVideo(true)}><Play size={13} />播放合成视频</button>}</div><i><b style={{ width: `${compositionRow.progress * 100}%` }} /></i><em>{Math.round(compositionRow.progress * 100)}%</em></article>;
  return createPortal(<><div className="modal-backdrop"><section className="auto-workflow-modal" role="dialog" aria-modal="true" aria-labelledby="auto-workflow-title"><header><div><span className="eyebrow">AUTOMATIC PRODUCTION</span><h2 id="auto-workflow-title">项目自动制作工作流</h2><p>{state.mode === "fast" ? "快速模式" : "分镜图模式"} · {state.resolution === "default" ? "模型默认分辨率" : videoResolutionLabel(state.resolution)} · {state.message}</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="隐藏工作流"><X size={18} /></button></header><div className="auto-workflow-overall"><div><span>{state.running ? "工作流执行中" : state.cancelled ? "工作流已停止" : "工作流已完成"}</span><strong>{Math.round(overall * 100)}%</strong></div><i><b style={{ width: `${overall * 100}%` }} /></i>{state.retryMessage && <p><LoaderCircle className={state.running ? "spin" : ""} size={14} />{state.retryMessage}</p>}</div><div className="auto-workflow-body"><section className={state.stage === "assets" ? "active" : "completed"}><header><span>STEP 01</span><div><strong>场景图生成</strong><small>与角色图并行启动</small></div></header><div className="auto-workflow-task-list">{sceneRows.map(renderImageRow)}</div></section><section className={state.stage === "assets" ? "active" : "completed"}><header><span>STEP 02</span><div><strong>角色图生成</strong><small>与场景图并行启动</small></div></header><div className="auto-workflow-task-list">{characterRows.map(renderImageRow)}</div></section><section className={state.mode === "fast" ? "skipped" : state.stage === "storyboard" ? "active" : ["video", "composition", "completed"].includes(state.stage) ? "completed" : "pending"}><header><span>STEP 03</span><div><strong>分镜图生成</strong><small>{state.mode === "fast" ? "快速模式自动跳过" : "等待场景图和角色图全部完成"}</small></div></header>{state.mode === "storyboard" && <div className="auto-workflow-task-list">{shotImageRows.map(renderImageRow)}</div>}</section><section className={state.stage === "video" ? "active" : ["composition", "completed"].includes(state.stage) ? "completed" : "pending"}><header><span>STEP 04</span><div><strong>分镜视频生成</strong><small>严格等待所有前置资产完成</small></div></header><div className="auto-workflow-task-list">{videoRows.map(renderVideoRow)}</div></section><section className={state.stage === "composition" ? "active" : state.stage === "completed" ? "completed" : "pending"}><header><span>STEP 05</span><div><strong>完整视频合成</strong><small>按照项目分镜顺序合成为一个完整视频</small></div></header><div className="auto-workflow-task-list">{renderCompositionRow}</div></section></div><footer><span>{state.running ? "任务失败时将停留在当前步骤并自动重新检查、重试，不能跳过；隐藏弹窗不会停止工作流。" : state.cancelled ? "工作流已停止，不会继续创建或重试后续任务；已经完成的结果会保留。" : "所有项目制作步骤及完整视频合成均已完成。"}</span><div className="auto-workflow-footer-actions">{state.running && <button className="secondary-button danger-button" type="button" onClick={onStop} disabled={stopping}><X size={16} />{stopping ? "正在停止…" : "停止工作流"}</button>}<button className="primary-button" type="button" onClick={onClose}>{state.running ? "隐藏工作流" : state.cancelled ? "关闭" : "完成"}</button></div></footer></section></div>{showComposedVideo && compositionPath && currentComposition && <ProjectVideoPlayerModal projectPath={projectPath} record={currentComposition} aspectRatio={canonical.story.aspect_ratio || "9:16"} shotCount={canonical.shots.length} onClose={() => setShowComposedVideo(false)} />}</>, document.body);
}

function StoryPage({ canonical, projectPath, projectId }: { canonical: CanonicalProject; projectPath: string; projectId: string }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const update = useStudioStore((state) => state.updateCanonical);
  const pendingAgentProduction = useStudioStore((state) => state.pendingAgentProduction);
  const setPendingAgentProduction = useStudioStore((state) => state.setPendingAgentProduction);
  const localSettings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const projectVisualStyles = useQuery({ queryKey: ["visual-styles"], queryFn: listVisualStyles, staleTime: 60_000 });
  const settings = {
    ...localSettings,
    isLoading: localSettings.isLoading || projectVisualStyles.isLoading,
    data: localSettings.data ? { ...localSettings.data, visual_style_presets: projectVisualStyles.data ?? [] } : undefined,
  };
  const imageTasksQuery = useProjectImageTasks(projectPath);
  const generationRecordsQuery = useProjectGenerationRecords(projectPath);
  const activeWorkflowQuery = useQuery({ queryKey: ["active-automatic-workflow", projectPath, projectId], queryFn: () => getActiveAutomaticWorkflow(projectPath, projectId), refetchInterval: 2000 });
  const [showAutoMode, setShowAutoMode] = useState(false);
  const [autoMode, setAutoMode] = useState<AutoProjectMode>("fast");
  const [autoResolution, setAutoResolution] = useState("720p");
  const [startingWorkflow, setStartingWorkflow] = useState(false);
  const [stoppingWorkflow, setStoppingWorkflow] = useState(false);
  const [workflowStartError, setWorkflowStartError] = useState("");
  const [showProjectVideo, setShowProjectVideo] = useState(false);
  const [workflow, setWorkflow] = useState<AutoProjectWorkflowState>({ visible: false, running: false, mode: "fast", resolution: "720p", stage: "assets", message: "准备开始", retryMessage: "", imageTasks: [], records: [] });
  const resumedWorkflowId = useRef<string | undefined>(undefined);
  const workflowRunnerId = useRef<string | undefined>(undefined);
  const stoppedWorkflowIds = useRef(new Set<string>());
  const agentWorkflowHandled = useRef(false);
  const workflowPersistenceQueue = useRef<Promise<unknown>>(Promise.resolve());
  const workflowMediaSelections = useRef<{ image: MediaModelSelection; video: MediaModelSelection } | undefined>(undefined);
  const story = canonical.story;
  const projectEpisodes = canonical.episodes ?? [];
  const setStory = (patch: Partial<typeof story>) => update((model) => ({ ...model, story: { ...model.story, ...patch } }));
  const setEpisodes = (episodes: Episode[]) => update((model) => ({ ...model, episodes }));
  const setAspectRatio = (aspectRatio: string) => update((model) => ({ ...model, story: { ...model.story, aspect_ratio: aspectRatio }, shots: model.shots.map((shot) => ({ ...shot, aspect_ratio: aspectRatio })) }));
  const setVisualStyle = (visualStyle: string) => update((model) => ({ ...model, story: { ...model.story, visual_style: visualStyle }, shots: model.shots.map((shot) => ({ ...shot, visual_style: visualStyle })) }));
  const imageTasks = imageTasksQuery.data ?? [];
  const records = generationRecordsQuery.data ?? [];
  const completedProjectVideoRecord = currentProjectComposition(records);
  const projectVideoPath = completedProjectVideoRecord?.result_relative_path;
  const missingScenes = canonical.scenes.filter((scene) => !preferredProjectAsset(scene.reference_assets, latestTargetImage(imageTasks, "scene", scene.id))).length;
  const missingCharacters = canonical.characters.flatMap((character) => characterStates(character).map((state) => ({ character, state }))).filter(({ character, state }) => !characterStateImage(character, state, imageTasks)).length;
  const missingShotImages = canonical.shots.filter((shot) => !(latestTargetImage(imageTasks, "shot", shot.id) ?? firstProjectAsset(shot.reference_assets))).length;
  const totalVideoSeconds = canonical.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const videoSeconds = canonical.shots.filter((shot) => !records.some((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path) && !firstProjectAsset(shot.video_assets)).reduce((sum, shot) => sum + shot.duration, 0);
  useEffect(() => {
    const resolutions = autoWorkflowResolutions(settings.data?.video_generation_model);
    if (!resolutions.includes(autoResolution)) setAutoResolution(resolutions[0]!);
  }, [settings.data?.video_generation_model]);

  const runAutomaticWorkflow = async (mode: AutoProjectMode, resolution: string, workflowId: string): Promise<void> => {
    const chargeCancelled = (error: unknown) => errorTextFragments(error).some(value => value.includes("CREDIT_CONFIRMATION_CANCELLED") || value.includes("已取消或超时") || value.includes("取消积分确认"));
    const chargeStopped = (error: unknown) => chargeCancelled(error) || isInsufficientBalanceError(error) || errorTextFragments(error).some(value=>value.includes("WORKFLOW_CREDIT_STOPPED"));
    const ai = settings.data;
    if (!ai) return;
    if (!workflowMediaSelections.current?.image.workflowCreditId || !workflowMediaSelections.current?.video.workflowCreditId) {
      const message = "上次制作没有完整的积分确认，请重新点击一键自动创作。";
      await updateAutomaticWorkflow({project_path:projectPath,project_id:projectId,workflow_id:workflowId,status:"CANCELLED",stage:"assets",progress:0,message,snapshot:{items:[]}});
      setWorkflow(current=>({...current,running:false,cancelled:true,message}));
      await activeWorkflowQuery.refetch();
      return;
    }
    if (runningWorkflows.has(workflowId)) return;
    runningWorkflows.add(workflowId);
    workflowRunnerId.current = workflowId;
    setWorkflowQuiet(queryClient,workflowId,true);
    const mediaSelections = workflowMediaSelections.current;
    const workflowStoppedError = new Error("AUTOMATIC_WORKFLOW_STOPPED");
    const workflowBalanceStoppedError = new Error("AUTOMATIC_WORKFLOW_BALANCE_STOPPED");
    const ensureWorkflowRunning = () => {
      if (stoppedWorkflowIds.current.has(workflowId)) throw workflowStoppedError;
    };
    let persistedState: AutoProjectWorkflowState = { id: workflowId, visible: false, running: true, cancelled: false, mode, resolution, stage: "assets", message: "正在恢复自动制作工作流", retryMessage: "", imageTasks: imageTasksQuery.data ?? [], records: generationRecordsQuery.data ?? [] };
    const stopForInsufficientBalance = async (error: unknown) => {
      if (stoppedWorkflowIds.current.has(workflowId)) return;
      const reason = insufficientBalanceReason(error);
      const message = chargeCancelled(error) ? "你已取消本次生成，自动制作已停止，后面的内容不会继续扣分。" : `自动制作已停止，没有追加扣分：${readableError(error) || reason}`;
      stoppedWorkflowIds.current.add(workflowId);
      persistedState = { ...persistedState, running: false, cancelled: true, message, retryMessage: "" };
      setWorkflow((current) => current.id === workflowId ? { ...current, running: false, cancelled: true, message, retryMessage: "" } : current);
      await workflowPersistenceQueue.current.catch(() => undefined);
      const items = automaticWorkflowSnapshot(canonical, mode, persistedState.imageTasks, persistedState.records);
      try {
        await updateAutomaticWorkflow({
          project_path: projectPath,
          project_id: projectId,
          workflow_id: workflowId,
          status: "CANCELLED",
          stage: persistedState.stage,
          progress: automaticWorkflowProgress(items),
          message,
          snapshot: { items, ...workflowMediaSnapshot(mediaSelections) },
        });
        await activeWorkflowQuery.refetch();
      } catch (persistenceError) {
        setWorkflowStartError(`工作流已停止，但停止状态保存失败：${readableError(persistenceError)}。`);
      }
    };
    const failFastOnInsufficientBalance = async (error: unknown) => {
      if (!chargeStopped(error)) return;
      await stopForInsufficientBalance(error);
      throw workflowBalanceStoppedError;
    };
    const setProgress = (patch: Partial<AutoProjectWorkflowState>) => {
      if (stoppedWorkflowIds.current.has(workflowId)) return;
      persistedState = { ...persistedState, ...patch, id: workflowId };
      setWorkflow((current) => ({ ...current, ...patch, id: workflowId, mode, resolution,
        imageTasks: mergeTaskSnapshots(current.imageTasks, patch.imageTasks ?? []),
        records: mergeTaskSnapshots(current.records, patch.records ?? []),
      }));
      if (patch.imageTasks) queryClient.setQueryData<ImageGenerationTask[]>(["image-generation-tasks", projectPath], previous => mergeTaskSnapshots(previous ?? [], patch.imageTasks!));
      if (patch.records) queryClient.setQueryData<GenerationRecord[]>(["generation-records", projectPath], previous => mergeTaskSnapshots(previous ?? [], patch.records!));
      const stateToPersist = persistedState;
      const items = automaticWorkflowSnapshot(canonical, mode, persistedState.imageTasks, persistedState.records);
      const progress = automaticWorkflowProgress(items);
      workflowPersistenceQueue.current = workflowPersistenceQueue.current
        .catch(() => undefined)
        .then(() => updateAutomaticWorkflow({
          project_path: projectPath,
          project_id: projectId,
          workflow_id: workflowId,
          status: stateToPersist.running ? "RUNNING" : "COMPLETED",
          stage: stateToPersist.stage,
          progress,
          message: stateToPersist.message,
          retry_message: stateToPersist.retryMessage || undefined,
          snapshot: { items, ...workflowMediaSnapshot(mediaSelections) },
        }));
    };
    const retryRead = async <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
      while (true) {
        ensureWorkflowRunning();
        try {
          const result = await operation();
          ensureWorkflowRunning();
          return result;
        }
        catch (error) {
          if (error === workflowStoppedError || error === workflowBalanceStoppedError) throw error;
          await failFastOnInsufficientBalance(error);
          setProgress({ retryMessage: `${label}失败：${readableError(error)}。正在重新检查并重试…` });
          await workflowWait(2000);
          ensureWorkflowRunning();
        }
      }
    };
    try {
    ensureWorkflowRunning();
    let currentImageTasks = await retryRead("读取图片任务", () => listImageGenerationTasks(projectPath));
    let currentRecords = await retryRead("读取视频任务", () => listGenerationRecords(projectPath));
    setProgress({ running: true, mode, resolution, stage: "assets", message: "并发启动场景图与角色图生成", retryMessage: "", imageTasks: currentImageTasks, records: currentRecords });

    const createMissingAssets = async () => {
      ensureWorkflowRunning();
      const sceneTasks = canonical.scenes.filter((scene) => !preferredProjectAsset(scene.reference_assets, latestTargetImage(currentImageTasks, "scene", scene.id)) && !activeImageTask(latestTargetTask(currentImageTasks, "scene", scene.id))).map((scene) => sceneImageTask(scene, canonical));
      const characterTasks = canonical.characters.flatMap((character) => characterStates(character).map((state) => ({ character, state }))).filter(({ character, state }) => !characterStateImage(character, state, currentImageTasks) && !activeImageTask(latestTargetTask(currentImageTasks, "character_state", state.id))).map(({ character, state }) => characterImageTask(character, state, canonical, ai.character_image_prompt || CHARACTER_IMAGE_PROMPT));
      const creationResults = await Promise.allSettled([sceneTasks.length ? createImageGenerationTasks({ project_path: projectPath, project_id: projectId, ...mediaImageFields(mediaSelections.image), tasks: sceneTasks }) : Promise.resolve([]), characterTasks.length ? createImageGenerationTasks({ project_path: projectPath, project_id: projectId, ...mediaImageFields(mediaSelections.image), tasks: characterTasks }) : Promise.resolve([])]);
      const balanceError = creationResults.find((result): result is PromiseRejectedResult => result.status === "rejected" && chargeStopped(result.reason));
      if (balanceError) await failFastOnInsufficientBalance(balanceError.reason);
      const creationError = creationResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (creationError) setProgress({ retryMessage: `创建视觉资产任务失败：${readableError(creationError.reason)}。正在自动重试…` });
    };
    await createMissingAssets();
    ensureWorkflowRunning();
    while (true) {
      await workflowWait(1500);
      ensureWorkflowRunning();
      currentImageTasks = await retryRead("检查场景图和角色图任务", () => listImageGenerationTasks(projectPath));
      setProgress({ imageTasks: currentImageTasks });
      const scenesReady = canonical.scenes.every((scene) => Boolean(preferredProjectAsset(scene.reference_assets, latestTargetImage(currentImageTasks, "scene", scene.id))));
      const charactersReady = canonical.characters.every((character) => characterStates(character).every((state) => Boolean(characterStateImage(character, state, currentImageTasks))));
      if (scenesReady && charactersReady) break;
      const failedTasks = [...canonical.scenes.map((scene) => latestTargetTask(currentImageTasks, "scene", scene.id)), ...canonical.characters.flatMap((character) => characterStates(character).map((state) => latestTargetTask(currentImageTasks, "character_state", state.id)))].filter((task): task is ImageGenerationTask => task?.status === "FAILED");
      const balanceFailure = failedTasks.find((task) => chargeStopped(task.error));
      if (balanceFailure) await failFastOnInsufficientBalance(balanceFailure.error);
      const failedCount = failedTasks.length;
      if (failedCount) setProgress({ retryMessage: `检测到 ${failedCount} 个资产任务失败，正在停留于当前步骤并重新尝试…` });
      await createMissingAssets();
    }
    setProgress({ imageTasks: currentImageTasks, retryMessage: "", message: mode === "storyboard" ? "场景图和角色图已完成，开始生成分镜图" : "场景图和角色图已完成，准备生成分镜视频" });

    if (mode === "storyboard") {
      ensureWorkflowRunning();
      setProgress({ stage: "storyboard" });
      const createMissingShotImages = async () => {
        ensureWorkflowRunning();
        const tasks = canonical.shots.filter((shot) => !(latestTargetImage(currentImageTasks, "shot", shot.id) ?? firstProjectAsset(shot.reference_assets)) && !activeImageTask(latestTargetTask(currentImageTasks, "shot", shot.id))).map((shot) => ({ target_type: "shot" as const, target_id: shot.id, prompt: shot.image_prompt_customized ? shot.image_prompt : defaultShotImagePrompt(shot, canonical), aspect_ratio: canonical.story.aspect_ratio || shot.aspect_ratio || "9:16", reference_assets: shotReferenceAssets(shot, canonical, currentImageTasks) }));
        if (tasks.length) await createImageGenerationTasks({ project_path: projectPath, project_id: projectId, ...mediaImageFields(mediaSelections.image), tasks });
      };
      try {
        await createMissingShotImages();
      } catch (error) {
        await failFastOnInsufficientBalance(error);
        setProgress({ retryMessage: `创建分镜图任务失败：${readableError(error)}。正在重新检查并重试…` });
      }
      ensureWorkflowRunning();
      while (true) {
        await workflowWait(1500);
        ensureWorkflowRunning();
        currentImageTasks = await retryRead("检查分镜图任务", () => listImageGenerationTasks(projectPath));
        currentRecords = await retryRead("同步分镜图生成记录", () => listGenerationRecords(projectPath));
        setProgress({ imageTasks: currentImageTasks, records: currentRecords });
        const ready = canonical.shots.every((shot) => Boolean(latestTargetImage(currentImageTasks, "shot", shot.id) ?? firstProjectAsset(shot.reference_assets)));
        if (ready) break;
        const failedTasks = canonical.shots.map((shot) => latestTargetTask(currentImageTasks, "shot", shot.id)).filter((task): task is ImageGenerationTask => task?.status === "FAILED");
        const balanceFailure = failedTasks.find((task) => chargeStopped(task.error));
        if (balanceFailure) await failFastOnInsufficientBalance(balanceFailure.error);
        const failed = failedTasks.length;
        if (failed) setProgress({ retryMessage: `检测到 ${failed} 个分镜图任务失败，正在重新检查并重试，本步骤不会跳过…` });
        try {
          await createMissingShotImages();
        } catch (error) {
          await failFastOnInsufficientBalance(error);
          setProgress({ retryMessage: `创建分镜图任务失败：${readableError(error)}。正在重新检查并重试…` });
        }
      }
      setProgress({ retryMessage: "", message: "全部分镜图已完成，开始生成分镜视频" });
    }

    setProgress({ stage: "video", imageTasks: currentImageTasks, records: currentRecords, message: "并发启动全部未完成的分镜视频任务" });
    ensureWorkflowRunning();
    update((model) => ({ ...model, shots: model.shots.map((shot) => ({ ...shot, video_resolution: resolution === "default" ? undefined : resolution, use_image_as_video_first_frame: false, use_image_as_video_reference: mode === "storyboard" })) }));
    const createMissingVideos = async () => {
      ensureWorkflowRunning();
      const queueable = canonical.shots.filter((shot) => !currentRecords.some((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path) && !firstProjectAsset(shot.video_assets) && !currentRecords.some((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && activeGeneration(record)));
      const creationResults = await Promise.allSettled(queueable.map((shot) => createShotVideoGeneration(buildShotVideoGenerationInput(shot, canonical, projectPath, projectId, currentImageTasks, currentRecords, mediaSelections.video.model.model_code, { resolution: mediaSelections.video.resolution, shotImageMode: mode === "storyboard" ? "reference" : "none", mediaSelection: mediaSelections.video }))));
      const balanceError = creationResults.find((result): result is PromiseRejectedResult => result.status === "rejected" && chargeStopped(result.reason));
      if (balanceError) await failFastOnInsufficientBalance(balanceError.reason);
      const creationError = creationResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (creationError) setProgress({ retryMessage: `创建分镜视频任务失败：${readableError(creationError.reason)}。正在重新检查并重试…` });
    };
    await createMissingVideos();
    ensureWorkflowRunning();
    while (true) {
      await workflowWait(1500);
      ensureWorkflowRunning();
      currentRecords = await retryRead("检查分镜视频任务", () => listGenerationRecords(projectPath));
      setProgress({ records: currentRecords });
      const ready = canonical.shots.every((shot) => currentRecords.some((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path) || Boolean(firstProjectAsset(shot.video_assets)));
      if (ready) break;
      const failedRecords = canonical.shots.map((shot) => currentRecords.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id)).filter((record): record is GenerationRecord => record?.status === "FAILED");
      const balanceFailure = failedRecords.find((record) => chargeStopped(record.error));
      if (balanceFailure) await failFastOnInsufficientBalance(balanceFailure.error);
      const failed = failedRecords.length;
      if (failed) setProgress({ retryMessage: `检测到 ${failed} 个分镜视频任务失败，正在停留于第四步并重新尝试…` });
      await createMissingVideos();
    }
    setProgress({ stage: "composition", retryMessage: "", records: currentRecords, message: "全部分镜视频已完成，正在按分镜顺序合成完整视频" });
    ensureWorkflowRunning();
    const createMissingComposition = async () => {
      ensureWorkflowRunning();
      const completed = currentProjectComposition(currentRecords);
      const active = currentRecords.find((record) => record.media_type === "video" && record.target_type === "project" && activeGeneration(record));
      if (!completed && !active) {
        await composeProjectVideo({
          project_path: projectPath,
          project_id: projectId,
          ordered_shot_ids: canonical.shots.map((shot) => shot.id),
          aspect_ratio: canonical.story.aspect_ratio === "16:9" ? "16:9" : "9:16",
        });
      }
    };
    try {
      await createMissingComposition();
    } catch (error) {
      await failFastOnInsufficientBalance(error);
      setProgress({ retryMessage: `启动完整视频合成失败：${readableError(error)}。正在重新检查并重试…` });
    }
    ensureWorkflowRunning();
    while (true) {
      await workflowWait(1500);
      ensureWorkflowRunning();
      currentRecords = await retryRead("检查完整视频合成任务", () => listGenerationRecords(projectPath));
      setProgress({ records: currentRecords });
      const completed = currentProjectComposition(currentRecords);
      if (completed) break;
      const failed = currentRecords.find((record) => record.media_type === "video" && record.target_type === "project" && record.status === "FAILED");
      if (failed && chargeStopped(failed.error)) await failFastOnInsufficientBalance(failed.error);
      if (failed) setProgress({ retryMessage: `完整视频合成失败：${failed.error?.message || "未知错误"}。正在停留于第五步并重新尝试…` });
      try {
        await createMissingComposition();
      } catch (error) {
        await failFastOnInsufficientBalance(error);
        setProgress({ retryMessage: `重新启动完整视频合成失败：${readableError(error)}。正在继续重试…` });
      }
    }
    setProgress({ running: false, stage: "completed", retryMessage: "", records: currentRecords, message: "场景、角色、分镜资产、分镜视频和完整合成视频均已完成" });
    await workflowPersistenceQueue.current;
    await Promise.all([imageTasksQuery.refetch(), generationRecordsQuery.refetch(), activeWorkflowQuery.refetch()]);
    } catch (error) {
      if (error === workflowStoppedError || error === workflowBalanceStoppedError) return;
      if (chargeStopped(error)) {
        await stopForInsufficientBalance(error);
        return;
      }
      const retryMessage = `工作流执行异常：${readableError(error)}。正在从当前步骤自动恢复…`;
      setProgress({ running: true, retryMessage, message: "工作流遇到异常，正在自动恢复" });
      await workflowPersistenceQueue.current.catch(() => undefined);
      await workflowWait(2000);
      if (!stoppedWorkflowIds.current.has(workflowId)) {
        runningWorkflows.delete(workflowId);
        return await runAutomaticWorkflow(mode, resolution, workflowId);
      }
    } finally {
      runningWorkflows.delete(workflowId);
      if (workflowRunnerId.current === workflowId) workflowRunnerId.current = undefined;
      setWorkflowQuiet(queryClient,workflowId,false);
      await invoke("stop_workflow_credit",{projectPath, id:mediaSelections.image.workflowCreditId}).catch(()=>undefined);
    }
  };
  const stopAutomaticWorkflow = async () => {
    if (!workflow.id || !workflow.running || stoppingWorkflow) return;
    if (!window.confirm("确定停止当前工作流吗？已完成的结果会保留，停止后不会继续创建或重试后续任务。")) return;
    const workflowId = workflow.id;
    stoppedWorkflowIds.current.add(workflowId);
    setStoppingWorkflow(true);
    setWorkflowStartError("");
    try {
      if (workflowMediaSelections.current?.image.workflowCreditId) await invoke("stop_workflow_credit", {projectPath,id:workflowMediaSelections.current.image.workflowCreditId});
      await workflowPersistenceQueue.current.catch(() => undefined);
      const items = automaticWorkflowSnapshot(canonical, workflow.mode, workflow.imageTasks, workflow.records);
      await updateAutomaticWorkflow({
        project_path: projectPath,
        project_id: projectId,
        workflow_id: workflowId,
        status: "CANCELLED",
        stage: workflow.stage,
        progress: automaticWorkflowProgress(items),
        message: "工作流已停止",
        snapshot: { items, ...workflowMediaSnapshot(workflowMediaSelections.current) },
      });
      setWorkflow((current) => current.id === workflowId ? { ...current, running: false, cancelled: true, message: "工作流已停止", retryMessage: "" } : current);
      await activeWorkflowQuery.refetch();
    } catch (error) {
      setWorkflowStartError(`停止工作流失败：${readableError(error)}。请重试。`);
    } finally {
      setStoppingWorkflow(false);
    }
  };
  const startAutoWorkflow = async (choice: WorkflowStartChoice) => {
    if (startingWorkflow) return;
    setStartingWorkflow(true);
    setWorkflowStartError("");
    let creditId: string | undefined;
    try {
      if (imageTasks.some(activeImageTask) || records.some(activeGeneration)) throw new Error("还有内容正在生成，请等待完成后再开始自动创作。");
      const currentBalance = await getCreditBalance();
      const total = choice.items.reduce((sum,item)=>sum+Math.round(item.credits*1e6),0)/1e6;
      if(currentBalance.available < total) throw new Error(`积分不够，本次需要 ${total} 分。`);
      creditId = await invoke<string>("approve_workflow_credit",{projectPath,apiBase:platformApiBaseUrl,items:choice.items});
      const image = {...choice.image,workflowCreditId:creditId};
      const video = {...choice.video,workflowCreditId:creditId};
      workflowMediaSelections.current = { image, video };
      const selectedResolution = video.resolution;
      setAutoResolution(selectedResolution);
      const created = await createAutomaticWorkflow({ project_path: projectPath, project_id: projectId, mode: autoMode, resolution: selectedResolution });
      await updateAutomaticWorkflow({ project_path: projectPath, project_id: projectId, workflow_id: created.id, status: "RUNNING", stage: "assets", progress: 0, message: "正在初始化自动制作工作流", snapshot: { items: [], ...workflowMediaSnapshot(workflowMediaSelections.current) } });
      resumedWorkflowId.current = created.id;
      setShowAutoMode(false);
      setWorkflow({ id: created.id, visible: true, running: true, cancelled: false, mode: autoMode, resolution: selectedResolution, stage: "assets", message: "正在初始化自动制作工作流", retryMessage: "", imageTasks, records });
      void runAutomaticWorkflow(autoMode, selectedResolution, created.id);
    } catch (error) {
      if(creditId) await invoke("stop_workflow_credit",{projectPath,id:creditId}).catch(()=>undefined);
      setWorkflowStartError(`无法启动自动制作：${readableError(error)}`);
    } finally {
      setStartingWorkflow(false);
    }
  };
  useEffect(() => {
    if(agentWorkflowHandled.current || !pendingAgentProduction || pendingAgentProduction.project_id!==projectId || activeWorkflowQuery.isLoading) return;
    agentWorkflowHandled.current=true;
    setPendingAgentProduction(undefined);
    if(activeWorkflowQuery.data) return;
    setAutoMode(pendingAgentProduction.mode);
    setShowAutoMode(true);
  },[pendingAgentProduction,projectId,activeWorkflowQuery.isLoading,activeWorkflowQuery.data]);
  useEffect(() => {
    const active = activeWorkflowQuery.data;
    if (!active || !settings.data || imageTasksQuery.isLoading || generationRecordsQuery.isLoading || resumedWorkflowId.current === active.id) return;
    resumedWorkflowId.current = active.id;
    workflowMediaSelections.current = restoredWorkflowMedia(active.snapshot);
    setAutoMode(active.mode);
    setAutoResolution(active.resolution);
    setWorkflow({
      id: active.id,
      visible: false,
      running: true,
      cancelled: false,
      mode: active.mode,
      resolution: active.resolution,
      stage: active.stage,
      message: active.message || "正在恢复上次未完成的自动制作工作流",
      retryMessage: active.retry_message || "",
      imageTasks,
      records,
    });
    void runAutomaticWorkflow(active.mode, active.resolution, active.id);
  }, [activeWorkflowQuery.data?.id, settings.data, imageTasksQuery.isLoading, generationRecordsQuery.isLoading]);
  const hasRunningWorkflow = workflow.running || Boolean(activeWorkflowQuery.data);
  useEffect(() => {
    const active=activeWorkflowQuery.data;
    setWorkflow(current => {
      if (!current.id) return current;
      const next = { ...current, imageTasks: mergeTaskSnapshots(current.imageTasks, imageTasks), records: mergeTaskSnapshots(current.records, records) };
      if (active?.id === current.id && current.running && workflowRunnerId.current !== current.id) {
        next.stage = active.stage;
        next.message = active.message;
        next.retryMessage = active.retry_message || "";
      }
      // The runner owns stage/message. A delayed DB snapshot must not overwrite
      // its state; keep watching submitted tasks even after the workflow stops.
      if (activeWorkflowQuery.isSuccess && !active && current.running && !runningWorkflows.has(current.id)) {
        return { ...next, running: false, cancelled: !projectVideoPath, stage: projectVideoPath ? "completed" : current.stage, message: projectVideoPath ? "自动制作已完成" : "自动制作已停止，请查看任务记录。" };
      }
      return next;
    });
  },[activeWorkflowQuery.data,activeWorkflowQuery.isSuccess,imageTasksQuery.data,generationRecordsQuery.data]);
  const planned: PlannedMedia[] = [
    ...canonical.scenes.filter(scene=>!preferredProjectAsset(scene.reference_assets,latestTargetImage(imageTasks,"scene",scene.id))).map(scene=>({key:`image:scene:${scene.id}`,group:"场景图" as const})),
    ...canonical.characters.flatMap(character=>characterStates(character).filter(state=>!characterStateImage(character,state,imageTasks)).map(state=>({key:`image:character_state:${state.id}`,group:"角色图" as const}))),
    ...(autoMode==="storyboard"?canonical.shots.filter(shot=>!(latestTargetImage(imageTasks,"shot",shot.id)??firstProjectAsset(shot.reference_assets))).map(shot=>({key:`image:shot:${shot.id}`,group:"分镜图" as const})):[]),
    ...canonical.shots.filter(shot=>!records.some(record=>record.media_type==="video"&&record.target_type==="shot"&&record.target_id===shot.id&&record.status==="COMPLETED"&&record.result_relative_path)&&!firstProjectAsset(shot.video_assets)).map(shot=>({key:`video:shot:${shot.id}`,group:"分镜视频" as const,seconds:shot.duration})),
  ];
  return <div className="story-page-layout"><section className="panel story-main story-main-single">

    {workflowStartError && <div className="error-banner">{workflowStartError}</div>}
    <input className="title-input" value={story.title} onChange={(e) => setStory({ title: e.target.value })} />
    <div className="story-meta-grid"><label>{t("theme")}<input value={story.theme} onChange={(e) => setStory({ theme: e.target.value })} /></label><label>{t("tone")}<input value={story.tone} onChange={(e) => setStory({ tone: e.target.value })} /></label><label>{t("projectAspectRatio")}<select value={story.aspect_ratio ?? canonical.shots[0]?.aspect_ratio ?? "9:16"} onChange={(e) => setAspectRatio(e.target.value)}><option value="9:16">9:16</option><option value="16:9">16:9</option></select></label><GroupedVisualStyleSelect value={story.visual_style ?? ""} onChange={setVisualStyle} presets={settings.data?.visual_style_presets ?? []} automaticLabel="使用视频理解生成的画风" /></div>
    <label>{t("logline")}<textarea value={story.logline} rows={3} onChange={(e) => setStory({ logline: e.target.value })} /></label>
    <label>{t("synopsis")}<textarea value={story.synopsis} rows={7} onChange={(e) => setStory({ synopsis: e.target.value })} /></label>
    {projectEpisodes.length > 0 && <section className="story-episodes"><header><div><span className="section-label">EPISODES</span><h3>分集内容</h3></div></header><div>{projectEpisodes.map((episode, index) => <article key={episode.id}><header><span>{String(index + 1).padStart(2, "0")}</span><input value={episode.title} onChange={(event) => setEpisodes(projectEpisodes.map((item) => item.id === episode.id ? { ...item, title: event.target.value } : item))} /><em>{Math.round(episode.duration)}秒</em></header><textarea rows={7} value={episode.content} onChange={(event) => setEpisodes(projectEpisodes.map((item) => item.id === episode.id ? { ...item, content: event.target.value } : item))} /></article>)}</div></section>}
    <label>{t("projectStyle")}<textarea rows={4} value={story.visual_style ?? canonical.shots[0]?.visual_style ?? ""} onChange={(e) => setVisualStyle(e.target.value)} /><small>默认采用视频理解结果；选择预设或直接编辑后，会同步到全部分镜。</small></label>
    {showAutoMode && settings.data && <WorkflowStartModal mode={autoMode} planned={planned} onModeChange={setAutoMode} onCancel={() => setShowAutoMode(false)} onStart={choice=>void startAutoWorkflow(choice)} busy={startingWorkflow} error={workflowStartError} />}
    {workflow.visible && <AutoProjectWorkflowModal canonical={canonical} projectPath={projectPath} state={workflow} stopping={stoppingWorkflow} onStop={() => void stopAutomaticWorkflow()} onClose={() => setWorkflow((current) => ({ ...current, visible: false }))} />}
    {showProjectVideo && projectVideoPath && completedProjectVideoRecord && <ProjectVideoPlayerModal projectPath={projectPath} record={completedProjectVideoRecord} aspectRatio={canonical.story.aspect_ratio || "9:16"} shotCount={canonical.shots.length} onClose={() => setShowProjectVideo(false)} />}
  </section><footer className="story-auto-footer"><div className="story-auto-actions">{projectVideoPath && <button className="secondary-button" type="button" onClick={() => setShowProjectVideo(true)}><Play size={17} />播放合成视频</button>}{hasRunningWorkflow ? <button className="secondary-button active-workflow-button" type="button" onClick={() => setWorkflow((current) => ({ ...current, visible: true }))}><LoaderCircle className="spin" size={17} />打开正在进行的工作流</button> : <button className="primary-button" type="button" onClick={() => setShowAutoMode(true)} disabled={settings.isLoading || imageTasksQuery.isLoading || generationRecordsQuery.isLoading || activeWorkflowQuery.isLoading || startingWorkflow}><WandSparkles size={17} />{startingWorkflow ? "正在创建工作流…" : "一键自动创作"}</button>}</div></footer></div>;
}

function ProjectAssetPreview({ projectPath, relativePath, fallback }: { projectPath: string; relativePath?: string; fallback: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const asset = useQuery({
    queryKey: ["project-asset", projectPath, relativePath],
    queryFn: () => readProjectAsset(projectPath, relativePath!),
    enabled: Boolean(relativePath),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);
  if (!relativePath || !asset.data) return <>{fallback}</>;
  return <>
    <button className="generated-asset-button" type="button" onClick={() => setExpanded(true)} aria-label="查看生成图片大图">
      <img className="generated-asset-image" src={asset.data} alt="生成资产" />
    </button>
    {expanded && createPortal(<div className="asset-lightbox" role="dialog" aria-modal="true" aria-label="生成图片大图预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <section className="asset-lightbox-dialog">
        <button className="asset-lightbox-close" type="button" onClick={() => setExpanded(false)} aria-label="关闭大图预览"><X size={20} /></button>
        <img src={asset.data} alt="生成资产大图" />
        <small>图片按原始比例完整显示 · 点击外部区域或按 Esc 关闭</small>
      </section>
    </div>, document.body)}
  </>;
}

function CharacterLockChip({ projectPath, characterId, characterName, relativePath, onRemove }: { projectPath: string; characterId: string; characterName: string; relativePath?: string; onRemove: () => void }) {
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number }>();
  const asset = useQuery({
    queryKey: ["project-asset", projectPath, relativePath],
    queryFn: () => readProjectAsset(projectPath, relativePath!),
    enabled: Boolean(relativePath),
    staleTime: Infinity,
  });
  const showPreview = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPreviewPosition({
      left: Math.max(12, rect.left - 316),
      top: Math.min(Math.max(178, rect.top + rect.height / 2), window.innerHeight - 178),
    });
  };
  return <span className="character-lock-chip" onMouseEnter={(event) => showPreview(event.currentTarget)} onMouseLeave={() => setPreviewPosition(undefined)}>
    <span className="character-lock-avatar">{asset.data ? <img src={asset.data} alt="" /> : <CircleUserRound size={16} />}</span>
    <span className="character-lock-name">{characterName}</span>
    <button type="button" onClick={onRemove} aria-label={`移除角色 ${characterName}`}><X size={13} /></button>
    {previewPosition && createPortal(<aside className="character-lock-preview" style={previewPosition} aria-hidden="true">
      {asset.data ? <img src={asset.data} alt="" /> : <div className="character-lock-preview-empty"><CircleUserRound size={42} /><span>尚未生成角色图</span></div>}
      <strong>{characterName}</strong>
      <small>{characterId}</small>
    </aside>, document.body)}
  </span>;
}

const activeImageTask = (task?: ImageGenerationTask) => Boolean(task && !["COMPLETED", "FAILED"].includes(task.status));

function useProjectImageTasks(projectPath: string) {
  const query = useQuery({
    queryKey: ["image-generation-tasks", projectPath],
    queryFn: () => listImageGenerationTasks(projectPath),
    refetchInterval: 1500,
  });
  useEffect(() => {
    void resumeImageGenerationTasks(projectPath).then(() => query.refetch()).catch(() => undefined);
  }, [projectPath]);
  return query;
}

const activeGeneration = (record?: GenerationRecord) => Boolean(record && !["COMPLETED", "FAILED"].includes(record.status));

function useProjectGenerationRecords(projectPath: string) {
  return useQuery({
    queryKey: ["generation-records", projectPath],
    queryFn: () => listGenerationRecords(projectPath),
    refetchInterval: 1500,
  });
}

function ShotGeneratedMedia({ projectPath, relativePath, mediaType }: { projectPath: string; relativePath?: string; mediaType: "image" | "video" }) {
  const asset = useQuery({
    queryKey: ["project-asset", projectPath, relativePath],
    queryFn: () => readProjectAsset(projectPath, relativePath!),
    enabled: Boolean(relativePath),
    staleTime: Infinity,
  });
  if (!relativePath) return <div className="shot-media-empty">{mediaType === "image" ? <ImageIcon size={38} /> : <Clapperboard size={38} />}<span>尚未生成</span></div>;
  if (asset.isLoading) return <div className="shot-media-empty"><LoaderCircle className="spin" size={32} /><span>正在读取本地文件…</span></div>;
  if (asset.error || !asset.data) return <div className="shot-media-empty error"><AlertTriangle size={30} /><span>本地生成文件读取失败</span></div>;
  return mediaType === "image" ? <img className="shot-generated-image" src={asset.data} alt="分镜生成图" /> : <video className="shot-generated-video" src={asset.data} controls preload="metadata" />;
}

function defaultShotImagePrompt(shot: Shot, canonical: CanonicalProject): string {
  return [
    `画面：${shot.visual}`,
    `项目画风：${shot.visual_style || canonical.story.visual_style || "电影级统一视觉风格"}`,
  ].join("\n");
}

const shotParameterTranslations: Record<string, Partial<Record<AppLocale, string>>> = {
  WIDE: { "zh-CN": "全景", "zh-TW": "全景", en: "Wide", ja: "ワイド", ko: "전경", fr: "Plan large", es: "Plano general", pt: "Plano aberto", de: "Weitaufnahme", bo: "ཡོངས་རྫོགས།", ug: "ئومۇمىي كۆرۈنۈش", mn: "Өргөн план" },
  MEDIUM: { "zh-CN": "中景", "zh-TW": "中景", en: "Medium", ja: "ミディアム", ko: "중경", fr: "Plan moyen", es: "Plano medio", pt: "Plano médio", de: "Halbnah", bo: "བར་མ།", ug: "ئوتتۇرا كۆرۈنۈش", mn: "Дунд план" },
  CLOSE_UP: { "zh-CN": "近景", "zh-TW": "近景", en: "Close-up", ja: "クローズアップ", ko: "근경", fr: "Gros plan", es: "Primer plano", pt: "Primeiro plano", de: "Nahaufnahme", bo: "ཉེ་བ།", ug: "يېقىن كۆرۈنۈش", mn: "Ойрын план" },
  MEDIUM_CLOSE_UP: { "zh-CN": "中近景", "zh-TW": "中近景", en: "Medium close-up", ja: "ミディアムクローズアップ", ko: "중근경", fr: "Plan rapproché", es: "Plano medio corto", pt: "Plano médio fechado", de: "Amerikanische Einstellung", bo: "བར་ཉེ།", ug: "ئوتتۇرا يېقىن كۆرۈنۈش", mn: "Дунд ойрын план" },
  EYE_LEVEL: { "zh-CN": "平视", "zh-TW": "平視", en: "Eye level", ja: "アイレベル", ko: "눈높이", fr: "Niveau des yeux", es: "Nivel de ojos", pt: "Nível dos olhos", de: "Augenhöhe", bo: "ཐད་ཀར།", ug: "كۆز ئېگىزلىكى", mn: "Нүдний түвшин" },
  HIGH_ANGLE: { "zh-CN": "俯拍", "zh-TW": "俯拍", en: "High angle", ja: "俯瞰", ko: "부감", fr: "Plongée", es: "Picado", pt: "Plongée", de: "Aufsicht", bo: "སྟེང་ནས།", ug: "ئۈستىدىن", mn: "Дээрээс" },
  LOW_ANGLE: { "zh-CN": "仰拍", "zh-TW": "仰拍", en: "Low angle", ja: "ローアングル", ko: "로우 앵글", fr: "Contre-plongée", es: "Contrapicado", pt: "Contra-plongée", de: "Untersicht", bo: "འོག་ནས།", ug: "ئاستىدىن", mn: "Доороос" },
  STATIC: { "zh-CN": "固定", "zh-TW": "固定", en: "Static", ja: "固定", ko: "고정", fr: "Fixe", es: "Fija", pt: "Fixa", de: "Statisch", bo: "གཏན་འཇགས།", ug: "مۇقىم", mn: "Тогтвортой" },
  SLOW_PUSH_IN: { "zh-CN": "缓慢推进", "zh-TW": "緩慢推進", en: "Slow push-in", ja: "ゆっくり前進", ko: "느린 전진", fr: "Travelling avant lent", es: "Avance lento", pt: "Avanço lento", de: "Langsame Zufahrt", bo: "དལ་བུར་མདུན་སྐྱོད།", ug: "ئاستا يېقىنلاش", mn: "Удаан ойртох" },
  HANDHELD_FOLLOW: { "zh-CN": "手持跟拍", "zh-TW": "手持跟拍", en: "Handheld tracking", ja: "手持ち追従", ko: "핸드헬드 팔로우", fr: "Suivi caméra à l’épaule", es: "Seguimiento cámara en mano", pt: "Acompanhamento manual", de: "Handkamera-Verfolgung", bo: "ལག་འཛིན་རྗེས་འདེད།", ug: "قولدا ئەگىشىش", mn: "Гар камерын дагалт" },
  SLOW_PULL_OUT: { "zh-CN": "缓慢拉远", "zh-TW": "緩慢拉遠", en: "Slow pull-out", ja: "ゆっくり引き", ko: "느린 줌 아웃", fr: "Travelling arrière lent", es: "Retroceso lento", pt: "Recuo lento", de: "Langsame Rückfahrt", bo: "དལ་བུར་རྒྱབ་སྣུར།", ug: "ئاستا يىراقلاش", mn: "Удаан холдох" },
};

function localizedShotParameter(value: string, locale: AppLocale): string {
  return shotParameterTranslations[value.trim().toUpperCase()]?.[locale] ?? value;
}

function defaultShotVideoPrompt(shot: Shot, canonical: CanonicalProject, references: GenerationReferenceAssetInput[], locale: AppLocale = "zh-CN"): string {
  const sceneReference = references.find((item) => item.kind === "scene");
  const characterReferences = references.filter((item) => item.kind === "character");
  return [
    `运镜：${localizedShotParameter(shot.camera_movement || "STATIC", locale)}`,
    `画面：${shot.visual}`,
    `动作：${shot.action}`,
    `台词：${shot.dialogue || "无"}`,
    `声音：${shot.sound || "无"}`,
    `约束：${shot.constraints || shot.negative_prompt || "角色、场景与参考图一致；动作自然；无畸形；无文字水印；不要字幕"}`,
    sceneReference ? `场景参考图：${sceneReference.label}` : "场景参考图：未生成，不传递",
    ...characterReferences.map((item) => `角色参考图：${item.label}`),
    shot.use_image_as_video_first_frame
      ? "首帧要求：使用当前分镜图作为视频第一帧，并从该画面自然开始运动。"
      : shot.use_image_as_video_reference
        ? "分镜图参考要求：视频生成整体参考当前分镜图的角色、场景、构图、光影和视觉风格，保持画面一致性；该图片仅作为整体参考图，不要求作为视频首帧。"
        : "",
    `项目画风：${shot.visual_style || canonical.story.visual_style || "电影级统一视觉风格"}`,
  ].filter(Boolean).join("\n");
}

function withShotImageInstruction(prompt: string, mode: "first_frame" | "reference" | undefined): string {
  const lines = prompt.split("\n").filter((line) => !line.trim().startsWith("首帧要求：") && !line.trim().startsWith("分镜图参考要求："));
  if (!mode) return lines.join("\n");
  const styleIndex = lines.findIndex((line) => line.trim().startsWith("项目画风："));
  const instruction = mode === "first_frame"
    ? "首帧要求：使用当前分镜图作为视频第一帧，并从该画面自然开始运动。"
    : "分镜图参考要求：视频生成整体参考当前分镜图的角色、场景、构图、光影和视觉风格，保持画面一致性；该图片仅作为整体参考图，不要求作为视频首帧。";
  lines.splice(styleIndex >= 0 ? styleIndex : lines.length, 0, instruction);
  return lines.join("\n");
}

type SeedanceVideoVersion = "Mini" | "快速" | "标准";

function matchesSeedanceVersion(value?: string): value is SeedanceVideoVersion {
  return value === "Mini" || value === "快速" || value === "标准";
}

function videoResolutionOptions(model?: string, version: SeedanceVideoVersion = "标准"): string[] {
  if (model === "hailuo-h3-cankaosheng") return ["768P", "2K"];
  if (model === "kwvideo-v2-ref") return version === "标准" ? ["480p", "720p", "1080p", "4K"] : ["480p", "720p"];
  if (model === "omni_flash-10s") return [];
  return ["720p", "1080p"];
}

function videoResolutionLabel(resolution: string): string {
  return resolution === "768P" ? "768p" : resolution === "2K" ? "2k" : resolution === "4K" ? "4k" : resolution;
}

function characterStates(character: Character): CharacterState[] {
  if (character.states?.length) return character.states;
  const appearanceLock = character.appearance_lock ?? character.appearance.face;
  const clothingLock = character.clothing_lock ?? character.appearance.clothes;
  return [{
    id: `${character.id}_STATE_001`,
    name: "默认状态",
    trigger: "角色常规出场",
    description: `${appearanceLock}；${clothingLock}`,
    appearance_lock: appearanceLock,
    clothing_lock: clothingLock,
    reference_assets: character.reference_assets ?? [],
    locked: false,
  }];
}

function selectedCharacterState(shot: Shot, character: Character): CharacterState {
  const states = characterStates(character);
  const stateId = shot.character_state_ids?.[character.id];
  return states.find((state) => state.id === stateId) ?? states[0]!;
}

function importedProjectAsset(paths?: string[]): string | undefined {
  return (paths ?? []).find((path) => path.replaceAll("\\", "/").startsWith("assets/imported/"));
}

function firstProjectAsset(paths?: string[]): string | undefined {
  return (paths ?? []).find((path) => {
    const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    return ["assets/", "characters/", "scenes/", "shots/", "storyboard/", "generated/", "derived/"].some((prefix) => normalized.startsWith(prefix));
  });
}

function preferredProjectAsset(paths: string[] | undefined, generated?: string): string | undefined {
  return importedProjectAsset(paths) ?? generated ?? firstProjectAsset(paths);
}

function characterStateImage(character: Character, state: CharacterState, imageTasks: ImageGenerationTask[]): string | undefined {
  return preferredProjectAsset(state.reference_assets, latestTargetImage(imageTasks, "character_state", state.id))
    ?? (!character.states?.length && characterStates(character).length === 1
      ? preferredProjectAsset(character.reference_assets, latestTargetImage(imageTasks, "character", character.id))
      : undefined);
}

function normalizedShotCharacterStates(characterIds: string[], current: Record<string, string> | undefined, canonical: CanonicalProject): Record<string, string> {
  return Object.fromEntries(characterIds.flatMap((characterId) => {
    const character = canonical.characters.find((item) => item.id === characterId);
    if (!character) return [];
    const states = characterStates(character);
    const selected = states.find((state) => state.id === current?.[characterId]) ?? states[0];
    return selected ? [[characterId, selected.id]] : [];
  }));
}

function shotCharacterIds(shot: Shot): string[] {
  return Array.isArray(shot.character_ids) ? shot.character_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function shotCharacterLockText(characterIds: string[], stateIds: Record<string, string>, canonical: CanonicalProject): string {
  return characterIds.flatMap((characterId) => {
    const character = canonical.characters.find((item) => item.id === characterId);
    if (!character) return [];
    const states = characterStates(character);
    const state = states.find((item) => item.id === stateIds[characterId]) ?? states[0]!;
    return [character.id + "｜" + character.name + "｜" + state.name + "｜" + state.appearance_lock + "；" + state.clothing_lock];
  }).join("\n");
}

function shotReferenceAssets(shot: Shot, canonical: CanonicalProject, imageTasks: ImageGenerationTask[]): GenerationReferenceAssetInput[] {
  const references: GenerationReferenceAssetInput[] = [];
  const scene = canonical.scenes.find((item) => item.id === shot.scene_id);
  const scenePath = scene ? preferredProjectAsset(scene.reference_assets, latestTargetImage(imageTasks, "scene", scene.id)) : undefined;
  if (scene && scenePath) references.push({ relative_path: scenePath, label: `场景“${scene.name}”`, kind: "scene" });
  for (const characterId of shotCharacterIds(shot)) {
    const character = canonical.characters.find((item) => item.id === characterId);
    if (!character) continue;
    const state = selectedCharacterState(shot, character);
    const characterPath = characterStateImage(character, state, imageTasks);
    if (characterPath) references.push({ relative_path: characterPath, label: `角色“${character.name}”·${state.name}`, kind: "character" });
  }
  return references;
}

function completedShotImagePath(shot: Shot, records: GenerationRecord[]): string | undefined {
  return records.find((record) => record.media_type === "image" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path)?.result_relative_path ?? firstProjectAsset(shot.reference_assets);
}

function buildShotVideoGenerationInput(
  shot: Shot,
  canonical: CanonicalProject,
  projectPath: string,
  projectId: string,
  imageTasks: ImageGenerationTask[],
  records: GenerationRecord[],
  videoModel?: string,
  options?: { resolution?: string; shotImageMode?: "existing" | "none" | "reference"; locale?: AppLocale; mediaSelection?: MediaModelSelection },
): CreateShotVideoGenerationInput {
  const references = shotReferenceAssets(shot, canonical, imageTasks);
  const shotImagePath = completedShotImagePath(shot, records);
  const useFirstFrame = options?.shotImageMode === "existing" || !options?.shotImageMode ? Boolean(shot.use_image_as_video_first_frame && shotImagePath) : false;
  const useShotReference = options?.shotImageMode === "reference"
    ? Boolean(shotImagePath)
    : options?.shotImageMode === "none"
      ? false
      : Boolean(shot.use_image_as_video_reference && !useFirstFrame && shotImagePath);
  const mode = useFirstFrame ? "first_frame" : useShotReference ? "reference" : undefined;
  const basePrompt = shot.video_prompt_customized ? shot.video_prompt : defaultShotVideoPrompt(shot, canonical, references, options?.locale);
  const requestedResolution = options?.mediaSelection?.resolution ?? options?.resolution;
  const requiresStandardSeedance = videoModel === "kwvideo-v2-ref" && ["1080p", "4K"].includes(requestedResolution ?? "");
  const version: SeedanceVideoVersion = requiresStandardSeedance ? "标准" : videoModel === "kwvideo-v2-ref" && matchesSeedanceVersion(shot.video_version) ? shot.video_version : "标准";
  const resolutions = videoResolutionOptions(videoModel, version);
  const resolution = options?.mediaSelection ? options.mediaSelection.resolution : requestedResolution && resolutions.includes(requestedResolution) ? requestedResolution : shot.video_resolution && resolutions.includes(shot.video_resolution) ? shot.video_resolution : resolutions[0];
  return {
    ...mediaVideoFields(options?.mediaSelection ?? { model: { id: "", model_alias: "" } as PlatformMediaModel, resolution: resolution || "", creditCost: 0 }),
    project_path: projectPath,
    project_id: projectId,
    shot_id: shot.id,
    prompt: withShotImageInstruction(basePrompt, mode),
    aspect_ratio: canonical.story.aspect_ratio || shot.aspect_ratio || "9:16",
    duration: shot.duration,
    resolution,
    version: videoModel === "kwvideo-v2-ref" ? version : undefined,
    reference_assets: useShotReference && shotImagePath
      ? [...references, { relative_path: shotImagePath, label: "当前分镜图（视频整体参考图）", kind: "shot_reference" }]
      : references,
    first_frame_relative_path: useFirstFrame ? shotImagePath : undefined,
  };
}

function latestTargetTask(tasks: ImageGenerationTask[], targetType: "character" | "character_state" | "scene" | "shot", targetId: string) {
  return tasks.find((task) => task.target_type === targetType && task.target_id === targetId);
}

function latestTargetImage(tasks: ImageGenerationTask[], targetType: "character" | "character_state" | "scene" | "shot", targetId: string) {
  return tasks.find((task) => task.target_type === targetType && task.target_id === targetId && task.status === "COMPLETED" && task.result_relative_path)?.result_relative_path;
}

function characterImageTask(character: CanonicalProject["characters"][number], state: CharacterState, canonical: CanonicalProject, template: string): CreateImageGenerationTaskItem {
  const style = canonical.story.visual_style || "电影写实风格";
  const values: Record<string, string> = {
    visual_style: style,
    character_name: character.name,
    character_role: character.role,
    gender_age: `${character.gender || "按角色设定"}，${character.age_range || "按角色设定"}`,
    appearance_lock: state.appearance_lock || character.appearance_lock || character.appearance.face,
    clothing_lock: state.clothing_lock || character.clothing_lock || character.appearance.clothes,
    accessories: character.appearance.accessories || "无",
  };
  const prompt = Object.entries(values).reduce((result, [key, value]) => result.split(`{{${key}}}`).join(value), template)
    + `\n角色状态：${state.name}\n状态触发条件：${state.trigger}\n状态详细描述：${state.description}\n只生成“${state.name}”这一种形态，不得混入该角色其他状态的服装、伤势或变身特征。`;
  return { target_type: "character_state", target_id: state.id, prompt, aspect_ratio: canonical.story.aspect_ratio || "9:16" };
}

function CharactersPage({ canonical, projectPath, projectId }: { canonical: CanonicalProject; projectPath: string; projectId: string }) {
  const { t } = useI18n();
  const update = useStudioStore((state) => state.updateCanonical);
  const imageTasks = useProjectImageTasks(projectPath);
  const aiSettings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const [submittingId, setSubmittingId] = useState("");
  const [importingId, setImportingId] = useState("");
  const [libraryTarget, setLibraryTarget] = useState<{ character: Character; state: CharacterState }>();
  const [generationError, setGenerationError] = useState("");
  const [queueNotice, setQueueNotice] = useState("");
  const updateCharacter = (id: string, patch: Partial<Character>) => update((model) => ({
    ...model,
    characters: model.characters.map((item) => item.id === id ? { ...item, ...patch } : item),
  }));
  const updateState = (characterId: string, stateId: string, patch: Partial<CharacterState>) => update((model) => ({
    ...model,
    characters: model.characters.map((character) => character.id === characterId
      ? { ...character, states: characterStates(character).map((state) => state.id === stateId ? { ...state, ...patch } : state) }
      : character),
  }));
  const addState = (character: Character) => {
    const states = characterStates(character);
    updateCharacter(character.id, { states: [...states, {
      id: `${character.id}_STATE_${String(states.length + 1).padStart(3, "0")}`,
      name: "新状态",
      trigger: "",
      description: "",
      appearance_lock: character.appearance_lock ?? character.appearance.face,
      clothing_lock: "",
      reference_assets: [],
      locked: false,
    }] });
  };
  const removeState = (character: Character, stateId: string) => {
    const states = characterStates(character);
    if (states.length <= 1) return;
    updateCharacter(character.id, { states: states.filter((state) => state.id !== stateId) });
  };
  const importStateImage = async (character: Character, state: CharacterState, libraryPath?: string) => {
    const sourcePath = libraryPath ?? await chooseProjectImage();
    if (!sourcePath) return;
    setImportingId(state.id);
    setGenerationError("");
    setQueueNotice("");
    try {
      const relativePath = await importProjectReferenceImage(projectPath, sourcePath, "character_state", state.id);
      const remaining = (state.reference_assets ?? []).filter((path) => !path.replaceAll("\\", "/").startsWith("assets/imported/"));
      updateState(character.id, state.id, { reference_assets: [relativePath, ...remaining] });
      setQueueNotice(`已将“${character.name} · ${state.name}”的${libraryPath ? "资产库图片" : "本地图片"}复制到项目中，请点击顶部“保存”。`);
    } catch (error) {
      setGenerationError(readableError(error));
      if (libraryPath) throw new Error(readableError(error));
    } finally {
      setImportingId("");
    }
  };
  const queueStates = async (entries: Array<{ character: Character; state: CharacterState }>) => {
    const queueable = entries.filter(({ state }) => !activeImageTask(latestTargetTask(imageTasks.data ?? [], "character_state", state.id)));
    setQueueNotice("");
    if (!queueable.length) {
      setGenerationError("");
      setQueueNotice("当前所有角色状态图都正在生成中，本次没有创建重复任务。");
      return;
    }
    setSubmittingId(entries.length === 1 ? entries[0]!.state.id : "ALL");
    setGenerationError("");
    try {
      const selection = await requestMediaModel("IMAGE_GENERATION", "选择角色图生成模型");
      const template = aiSettings.data?.character_image_prompt || CHARACTER_IMAGE_PROMPT;
      const created = await createImageGenerationTasks({
        project_path: projectPath,
        project_id: projectId,
        ...mediaImageFields(selection),
        tasks: queueable.map(({ character, state }) => characterImageTask(character, state, canonical, template)),
      });
      const skipped = entries.length - created.length;
      if (skipped > 0) setQueueNotice(`已跳过 ${skipped} 个正在生成中的状态，只启动其余角色状态图。`);
      await imageTasks.refetch();
    } catch (error) {
      setGenerationError(readableError(error));
    } finally {
      setSubmittingId("");
    }
  };
  const allStates = canonical.characters.flatMap((character) => characterStates(character).map((state) => ({ character, state })));
  const tasks = imageTasks.data ?? [];
  return <div>
    <div className="section-intro"><div><span className="section-label">CHARACTER BIBLE</span><h2>{t("characterBible")}</h2></div><div className="section-actions"><span>{canonical.characters.length} 个角色 · {allStates.length} 个状态</span><button className="secondary-button" type="button" onClick={() => void queueStates(allStates)} disabled={Boolean(submittingId)}>{submittingId === "ALL" ? <LoaderCircle className="spin" size={16} /> : <Images size={16} />} 按状态生成全部图片</button></div></div>
    {generationError && <div className="error-banner generation-error">{generationError}</div>}
    {queueNotice && <div className="queue-notice">{queueNotice}</div>}
    <div className="character-state-list">{canonical.characters.map((character, index) => <article className="character-state-card" key={character.id}>
      <header className="character-state-card-heading"><div className={`character-avatar color-${index % 5}`}><CircleUserRound size={34} /></div><div><input value={character.name} onChange={(event) => updateCharacter(character.id, { name: event.target.value })} /><span>{character.id} · {character.role}</span></div><button className={character.locked ? "lock active" : "lock"} onClick={() => updateCharacter(character.id, { locked: !character.locked })}>{character.locked ? <Lock size={17} /> : <LockOpen size={17} />}</button></header>
      <div className="character-base-fields"><label>基础外貌<textarea rows={2} value={character.appearance_lock ?? character.appearance.face} onChange={(event) => updateCharacter(character.id, { appearance_lock: event.target.value })} /></label><label>{t("voiceLock")}<textarea rows={2} value={character.voice_lock ?? character.voice} onChange={(event) => updateCharacter(character.id, { voice_lock: event.target.value, voice: event.target.value })} /></label></div>
      <div className="character-state-section"><header><div><strong>角色状态</strong><small>每个状态独立生成参考图，分镜按情境选择</small></div><button type="button" onClick={() => addState(character)}><Plus size={14} />添加状态</button></header>
        <div className="character-state-grid">{characterStates(character).map((state) => {
          const task = latestTargetTask(tasks, "character_state", state.id);
          const imagePath = characterStateImage(character, state, tasks);
          return <section className="character-state-item" key={state.id}>
            <div className="character-state-preview"><ProjectAssetPreview projectPath={projectPath} relativePath={imagePath} fallback={<CircleUserRound size={42} />} /><span>{state.name}</span></div>
            <div className="character-state-fields"><header><input value={state.name} onChange={(event) => updateState(character.id, state.id, { name: event.target.value })} /><button type="button" title="删除状态" disabled={characterStates(character).length <= 1} onClick={() => removeState(character, state.id)}><X size={14} /></button></header>
              <input value={state.trigger} placeholder="出现条件，例如：完成神变后" onChange={(event) => updateState(character.id, state.id, { trigger: event.target.value })} />
              <textarea rows={2} value={state.description} placeholder="状态详细描述" onChange={(event) => updateState(character.id, state.id, { description: event.target.value })} />
              <textarea rows={2} value={state.appearance_lock} placeholder="外貌锁定" onChange={(event) => updateState(character.id, state.id, { appearance_lock: event.target.value })} />
              <textarea rows={2} value={state.clothing_lock} placeholder="服装、装备、伤势锁定" onChange={(event) => updateState(character.id, state.id, { clothing_lock: event.target.value })} />
              <div className="asset-source-actions asset-source-actions-with-library">
                <button className="asset-import-button" type="button" onClick={() => setLibraryTarget({ character, state })} disabled={Boolean(importingId)}><Images size={16} />从素材库选择</button>
                <button className="asset-import-button" type="button" onClick={() => void importStateImage(character, state)} disabled={Boolean(importingId)}>{importingId === state.id ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{importedProjectAsset(state.reference_assets) ? "更换本地图片" : "选择本地图片"}</button>
                <button className="asset-generate-button" type="button" onClick={() => void queueStates([{ character, state }])} disabled={Boolean(submittingId) || activeImageTask(task)}>{submittingId === state.id || activeImageTask(task) ? <LoaderCircle className="spin" size={16} /> : <ImageIcon size={16} />}{activeImageTask(task) ? `${t("generating")} ${Math.round((task?.progress ?? 0) * 100)}%` : imagePath ? `重新生成“${state.name}”` : `生成“${state.name}”`}</button>
              </div>
              {task?.status === "FAILED" && <small className="image-task-error">{t("generationFailed")}：{task.error?.message ?? "—"}</small>}
            </div>
          </section>;
        })}</div>
      </div>
    </article>)}</div>
    {libraryTarget && <AssetLibraryPickerModal assetType="character" onClose={() => setLibraryTarget(undefined)} onConfirm={async (asset) => {
      await importStateImage(libraryTarget.character, libraryTarget.state, asset.image_path);
      setLibraryTarget(undefined);
    }} />}
  </div>;
}

function sceneImageTask(scene: CanonicalProject["scenes"][number], canonical: CanonicalProject): CreateImageGenerationTaskItem {
  const style = canonical.story.visual_style || "电影写实风格";
  const props = Array.isArray(scene.props) ? scene.props.filter((item) => typeof item === "string" && item.trim()).join("、") : "";
  const prompt = [`场景概念设定图`, `整体画风：${style}`, `场景名称：${scene.name}`, `场景锁定：${scene.description || "按剧情中的具体空间结构保持一致"}`, `空间类型：${scene.location_type || "未指定"}`, `时间：${scene.time_of_day || "按剧情设定"}`, `光线：${scene.lighting || "符合时间和剧情氛围的电影级布光"}`, `空间布局：${scene.layout || scene.description || "空间关系清晰"}`, `关键道具：${props || "无"}`, `氛围：${scene.mood || "符合剧情情绪"}`, `生成无人场景全景概念图，空间关系清晰，固定陈设和关键道具完整，适合作为后续分镜统一参考，无人物、无文字、无水印`].join("。\n");
  return { target_type: "scene", target_id: scene.id, prompt, aspect_ratio: canonical.story.aspect_ratio || "9:16" };
}

function ScenesPage({ canonical, projectPath, projectId }: { canonical: CanonicalProject; projectPath: string; projectId: string }) {
  const { t } = useI18n();
  const update = useStudioStore((state) => state.updateCanonical);
  const imageTasks = useProjectImageTasks(projectPath);
  const [submittingId, setSubmittingId] = useState("");
  const [importingId, setImportingId] = useState("");
  const [libraryTarget, setLibraryTarget] = useState<Scene>();
  const [generationError, setGenerationError] = useState("");
  const [queueNotice, setQueueNotice] = useState("");
  const updateScene = (id: string, patch: Partial<CanonicalProject["scenes"][number]>) => update((model) => ({ ...model, scenes: model.scenes.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const importSceneImage = async (scene: CanonicalProject["scenes"][number], libraryPath?: string) => {
    const sourcePath = libraryPath ?? await chooseProjectImage();
    if (!sourcePath) return;
    setImportingId(scene.id);
    setGenerationError("");
    setQueueNotice("");
    try {
      const relativePath = await importProjectReferenceImage(projectPath, sourcePath, "scene", scene.id);
      const remaining = (scene.reference_assets ?? []).filter((path) => !path.replaceAll("\\", "/").startsWith("assets/imported/"));
      updateScene(scene.id, { reference_assets: [relativePath, ...remaining] });
      setQueueNotice(`已将“${scene.name}”的${libraryPath ? "资产库场景图" : "本地场景图"}复制到项目中，请点击顶部“保存”。`);
    } catch (error) {
      setGenerationError(readableError(error));
      if (libraryPath) throw new Error(readableError(error));
    } finally {
      setImportingId("");
    }
  };
  const queueScenes = async (scenes: CanonicalProject["scenes"]) => {
    const queueable = scenes.filter((scene) => !activeImageTask(latestTargetTask(imageTasks.data ?? [], "scene", scene.id)));
    const skipped = scenes.length - queueable.length;
    setQueueNotice("");
    if (queueable.length === 0) {
      setGenerationError("");
      setQueueNotice("当前所有场景图都正在生成中，本次没有创建重复任务。");
      return;
    }
    setSubmittingId(scenes.length === 1 ? scenes[0]!.id : "ALL");
    setGenerationError("");
    try {
      const selection = await requestMediaModel("IMAGE_GENERATION", "选择场景图生成模型");
      const created = await createImageGenerationTasks({ project_path: projectPath, project_id: projectId, ...mediaImageFields(selection), tasks: queueable.map((scene) => sceneImageTask(scene, canonical)) });
      const totalSkipped = scenes.length - created.length;
      if (totalSkipped > 0 || skipped > 0) setQueueNotice(`已跳过 ${Math.max(totalSkipped, skipped)} 个正在生成中的场景，只启动其余场景的生图任务。`);
      await imageTasks.refetch();
    } catch (error) {
      setGenerationError(readableError(error));
    } finally {
      setSubmittingId("");
    }
  };
  const tasks = imageTasks.data ?? [];
  return <div>
    <div className="section-intro"><div><span className="section-label">SCENE MEMORY</span><h2>{t("sceneMemory")}</h2></div><div className="section-actions"><span>{t("sceneCount", { count: canonical.scenes.length })}</span><button className="secondary-button" type="button" onClick={() => void queueScenes(canonical.scenes)} disabled={Boolean(submittingId)}>{submittingId === "ALL" ? <LoaderCircle className="spin" size={16} /> : <Images size={16} />} {t("generateAll")}</button></div></div>
    {generationError && <div className="error-banner generation-error">{generationError}</div>}
    {queueNotice && <div className="queue-notice">{queueNotice}</div>}
    <div className="scene-list">{canonical.scenes.map((scene, index) => {
      const task = latestTargetTask(tasks, "scene", scene.id);
      const importedPath = importedProjectAsset(scene.reference_assets);
      const imagePath = preferredProjectAsset(scene.reference_assets, latestTargetImage(tasks, "scene", scene.id));
      return <article className="scene-card" key={scene.id}><div className={`scene-visual scene-${index}`}><ProjectAssetPreview projectPath={projectPath} relativePath={imagePath} fallback={<Boxes size={42} />} /><span>{scene.time_of_day}</span></div><div className="scene-info"><div className="entity-title"><div><span>{scene.id}</span><input value={scene.name} onChange={(e) => updateScene(scene.id, { name: e.target.value })} /></div><button className={scene.locked ? "lock active" : "lock"} onClick={() => updateScene(scene.id, { locked: !scene.locked })}>{scene.locked ? <Lock size={17} /> : <LockOpen size={17} />}</button></div><div className="asset-source-actions asset-source-actions-with-library"><button className="asset-import-button" type="button" onClick={() => setLibraryTarget(scene)} disabled={Boolean(importingId)}><Images size={16} />从资产库选择</button><button className="asset-import-button" type="button" onClick={() => void importSceneImage(scene)} disabled={Boolean(importingId)}>{importingId === scene.id ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{importedPath ? "更换本地图片" : "选择本地图片"}</button><button className="asset-generate-button" type="button" onClick={() => void queueScenes([scene])} disabled={Boolean(submittingId) || activeImageTask(task)}>{submittingId === scene.id || activeImageTask(task) ? <LoaderCircle className="spin" size={16} /> : <ImageIcon size={16} />}{activeImageTask(task) ? `生成中 ${Math.round((task?.progress ?? 0) * 100)}%` : imagePath ? "重新生图" : "生图"}</button></div>{task?.status === "FAILED" && <small className="image-task-error">生成失败：{task.error?.message ?? "未知错误"}</small>}<textarea rows={3} value={scene.description} onChange={(e) => updateScene(scene.id, { description: e.target.value })} /><div className="scene-meta"><span>{scene.location_type}</span><span>{scene.lighting}</span></div></div></article>;
    })}</div>
    {libraryTarget && <AssetLibraryPickerModal assetType="scene" onClose={() => setLibraryTarget(undefined)} onConfirm={async (asset) => {
      await importSceneImage(libraryTarget, asset.image_path);
      setLibraryTarget(undefined);
    }} />}
  </div>;
}

function LegacyStoryboardPage({ canonical, projectPath }: { canonical: CanonicalProject; projectPath: string }) {
  const { selectedShotId, setSelectedShotId, updateCanonical } = useStudioStore();
  const imageTasks = useProjectImageTasks(projectPath);
  const selected = canonical.shots.find((shot) => shot.id === selectedShotId) ?? canonical.shots[0];
  const selectedCharacterIds = selected ? shotCharacterIds(selected) : [];
  const updateShot = (id: string, patch: Partial<Shot>) => updateCanonical((model) => ({ ...model, shots: model.shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot) }));
  const sourceRange = selected?.source_time_range ?? { start: 0, end: selected?.duration ?? 0 };
  const selectScene = (sceneId: string) => {
    const scene = canonical.scenes.find((item) => item.id === sceneId);
    const sequence = canonical.sequences.find((item) => item.scene_id === sceneId);
    if (selected && scene) updateShot(selected.id, { scene_id: sceneId, sequence_id: sequence?.id ?? selected.sequence_id, scene_lock: scene.description });
  };
  const selectCharacters = (ids: string[]) => { if (selected) { const stateIds = normalizedShotCharacterStates(ids, selected.character_state_ids, canonical); updateShot(selected.id, { character_ids: ids, character_state_ids: stateIds, character_lock: shotCharacterLockText(ids, stateIds, canonical) }); } };
  const selectCharacterState = (characterId: string, stateId: string) => { if (selected) { const stateIds = { ...normalizedShotCharacterStates(selectedCharacterIds, selected.character_state_ids, canonical), [characterId]: stateId }; updateShot(selected.id, { character_state_ids: stateIds, character_lock: shotCharacterLockText(selectedCharacterIds, stateIds, canonical) }); } };
  const mentionItems: VisualMentionItem[] = [];
  const tasks = imageTasks.data ?? [];
  if (selected) {
    const scene = canonical.scenes.find((item) => item.id === selected.scene_id);
    const scenePath = scene ? preferredProjectAsset(scene.reference_assets, latestTargetImage(tasks, "scene", scene.id)) : undefined;
    if (scene) mentionItems.push({ id: `scene:${scene.id}`, label: "场景图", detail: `${scene.id} · ${scene.name}${scenePath ? "" : " · 尚未生成图片"}`, insertText: "@场景图", relativePath: scenePath });
    for (const characterId of selectedCharacterIds) {
      const character = canonical.characters.find((item) => item.id === characterId);
      const characterPath = character ? latestTargetImage(tasks, "character", character.id) ?? character.reference_assets[0] : undefined;
      if (character) mentionItems.push({ id: `character:${character.id}`, label: character.name, detail: `角色图 · ${character.id}${characterPath ? "" : " · 尚未生成图片"}`, insertText: `@${character.name}`, relativePath: characterPath });
    }
    const shotPath = selected.reference_assets?.[0];
    if (shotPath) mentionItems.push({ id: `shot:${selected.id}`, label: "分镜图", detail: `${selected.id} · 当前分镜生成图`, insertText: "@分镜图", relativePath: shotPath });
  }
  return <div className="storyboard-layout">
    <section className="shot-list"><div className="panel-title"><div><span className="section-label">SHOT LIST</span><h3>{canonical.shots.length} 镜</h3></div><span>{canonical.shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(1)}s</span></div>{canonical.shots.map((shot, index) => <button key={shot.id} className={selected?.id === shot.id ? "shot-row active" : "shot-row"} onClick={() => setSelectedShotId(shot.id)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{shot.id}</strong><small>{shot.action}</small></div><em>{shot.duration}s</em></button>)}</section>
    {selected && <section className="shot-preview"><div className="shot-content-editor"><div className="panel-title"><div><span className="section-label">SHOT CONTENT</span><h3>分镜内容</h3></div></div><div className="shot-editor-row"><label>画面<VisualMentionEditor value={selected.visual} onChange={(visual) => updateShot(selected.id, { visual })} items={mentionItems} projectPath={projectPath} /></label><label>动作<textarea rows={4} value={selected.action} onChange={(e) => updateShot(selected.id, { action: e.target.value })} /></label></div><div className="shot-editor-row"><label>台词<textarea rows={3} value={selected.dialogue} onChange={(e) => updateShot(selected.id, { dialogue: e.target.value })} /></label><label>声音<textarea rows={3} value={selected.sound} onChange={(e) => updateShot(selected.id, { sound: e.target.value })} /></label></div></div><div className="preview-frame"><div className="frame-grid" /><Clapperboard size={54} /><span>{selected.id} · {selected.shot_size}</span><p>{selected.visual}</p></div><div className="shot-summary"><div><span>SCENE</span><strong>{canonical.scenes.find((scene) => scene.id === selected.scene_id)?.name}</strong></div><div><span>SOURCE</span><strong>{sourceRange.start}–{sourceRange.end}s</strong></div><div><span>RATIO</span><strong>{canonical.story.aspect_ratio || selected.aspect_ratio || "—"}</strong></div></div></section>}
    {selected && <section className="inspector">
      <span className="section-label">SHOT INSPECTOR</span>
      <div className="inspector-heading"><h3>{selected.id}</h3><button className={selected.locked ? "lock active" : "lock"} onClick={() => updateShot(selected.id, { locked: !selected.locked })}>{selected.locked ? <Lock size={17} /> : <LockOpen size={17} />}</button></div>
      <div className="inspector-core-grid"><label>时长<input type="number" step="0.5" value={selected.duration} onChange={(e) => updateShot(selected.id, { duration: Number(e.target.value) })} /></label><label>屏幕比例<input readOnly value={canonical.story.aspect_ratio ?? selected.aspect_ratio ?? "9:16"} /></label><label>景别<input value={selected.shot_size} onChange={(e) => updateShot(selected.id, { shot_size: e.target.value })} /></label><label>机位<input value={selected.camera_angle} onChange={(e) => updateShot(selected.id, { camera_angle: e.target.value })} /></label></div>
      <label>运镜<input value={selected.camera_movement} onChange={(e) => updateShot(selected.id, { camera_movement: e.target.value })} /></label>
      <label>画风设定<textarea rows={4} value={selected.visual_style ?? canonical.story.visual_style ?? ""} onChange={(e) => updateShot(selected.id, { visual_style: e.target.value })} /></label>
      <label>场景锁定<select value={selected.scene_id} onChange={(e) => selectScene(e.target.value)}>{canonical.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.id} · {scene.name}</option>)}</select></label>
      <label>人物锁定<select value="" onChange={(e) => { const id = e.target.value; if (id && !selectedCharacterIds.includes(id)) selectCharacters([...selectedCharacterIds, id]); }}><option value="">添加项目角色…</option>{canonical.characters.filter((character) => !selectedCharacterIds.includes(character.id)).map((character) => <option key={character.id} value={character.id}>{character.id} · {character.name}</option>)}</select></label>
      <div className="selected-character-locks">{selectedCharacterIds.map((id) => { const character = canonical.characters.find((item) => item.id === id); const characterState = character ? selectedCharacterState(selected, character) : undefined; const imagePath = character && characterState ? characterStateImage(character, characterState, tasks) : undefined; return character && characterState ? <CharacterLockChip key={id} projectPath={projectPath} characterId={character.id} characterName={character.name + " · " + characterState.name} relativePath={imagePath} onRemove={() => selectCharacters(selectedCharacterIds.filter((item) => item !== id))} /> : null; })}{selectedCharacterIds.length === 0 && <small>该分镜没有锁定人物</small>}</div>
      <div className="shot-character-state-selectors">{selectedCharacterIds.map((characterId) => { const character = canonical.characters.find((item) => item.id === characterId); if (!character) return null; const states = characterStates(character); const currentState = states.find((state) => state.id === selected.character_state_ids?.[characterId]) ?? states[0]!; return <label key={characterId}>{character.name}的状态<select value={currentState.id} onChange={(event) => selectCharacterState(characterId, event.target.value)}>{states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>; })}</div><label>生成约束<textarea rows={3} value={selected.constraints ?? selected.negative_prompt} onChange={(e) => updateShot(selected.id, { constraints: e.target.value, negative_prompt: e.target.value })} /></label>
    </section>}
  </div>;
}

type BulkVideoLaunchPhase = "pending" | "creating" | "created" | "existing" | "skipped" | "failed";

interface BulkVideoLaunchItem {
  phase: BulkVideoLaunchPhase;
  recordId?: string;
  error?: string;
}

type BulkVideoLaunchMap = Record<string, BulkVideoLaunchItem>;

function GenerateAllVideosConfirmModal({ total, completed, active, onCancel, onConfirm }: { total: number; completed: number; active: number; onCancel: () => void; onConfirm: () => void }) {
  const pending = Math.max(0, total - completed - active);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="bulk-video-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-video-confirm-title">
      <header><div className="bulk-video-modal-icon"><Clapperboard size={24} /></div><div><span className="eyebrow">BATCH VIDEO GENERATION</span><h2 id="bulk-video-confirm-title">生成所有分镜视频？</h2><p>确认后将为尚未生成视频的分镜创建生成任务。</p></div><button className="modal-close" type="button" onClick={onCancel} aria-label="关闭"><X size={18} /></button></header>
      <div className="bulk-video-confirm-body"><div className="bulk-video-warning"><AlertTriangle size={19} /><div><strong>已经生成过分镜视频的分镜会自动跳过</strong><span>正在生成中的任务也不会重复创建；关闭后生成任务仍会在后台继续执行。</span></div></div><div className="bulk-video-confirm-stats"><div><strong>{total}</strong><span>全部分镜</span></div><div><strong>{completed}</strong><span>已有视频，跳过</span></div><div><strong>{active}</strong><span>正在生成</span></div><div><strong>{pending}</strong><span>本次新建任务</span></div></div></div>
      <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="button" onClick={onConfirm}><Clapperboard size={16} />确认并开始生成</button></footer>
    </section>
  </div>, document.body);
}

function GenerateAllVideosProgressModal({ shots, records, launches, launching, onClose }: { shots: Shot[]; records: GenerationRecord[]; launches: BulkVideoLaunchMap; launching: boolean; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const rows = shots.map((shot) => {
    const launch = launches[shot.id] ?? { phase: "pending" as const };
    const record = launch.recordId ? records.find((item) => item.id === launch.recordId) : undefined;
    if (launch.phase === "skipped") return { shot, launch, record, status: "已有视频，已跳过", progress: 1, terminal: true, className: "skipped" };
    if (launch.phase === "failed" && !record) return { shot, launch, record, status: "任务创建失败", progress: 0, terminal: true, className: "failed" };
    if (launch.phase === "creating") return { shot, launch, record, status: "正在创建任务", progress: 0.03, terminal: false, className: "running" };
    if (record) return { shot, launch, record, status: generationStatusLabels[record.status], progress: record.progress, terminal: ["COMPLETED", "FAILED"].includes(record.status), className: record.status.toLowerCase() };
    return { shot, launch, record, status: launch.phase === "pending" ? "等待创建任务" : "任务已提交，等待同步", progress: 0, terminal: false, className: "pending" };
  });
  const completed = rows.filter((row) => row.terminal).length;
  const failed = rows.filter((row) => row.className === "failed").length;
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="bulk-video-progress-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-video-progress-title">
      <header><div><span className="eyebrow">BATCH VIDEO TASKS</span><h2 id="bulk-video-progress-title">所有分镜视频生成进度</h2><p>共 {shots.length} 个分镜，已结束 {completed} 个{failed ? `，失败 ${failed} 个` : ""}。视频任务由后台并发队列执行。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="bulk-video-overall-progress"><div><span>整体进度</span><strong>{shots.length ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / shots.length * 100) : 100}%</strong></div><i><b style={{ width: `${shots.length ? rows.reduce((sum, row) => sum + row.progress, 0) / shots.length * 100 : 100}%` }} /></i></div>
      <div className="bulk-video-task-list">{rows.map((row, index) => <article className={`bulk-video-task-row ${row.className}`} key={row.shot.id}><span className="bulk-video-task-index">{String(index + 1).padStart(2, "0")}</span><div className="bulk-video-task-info"><strong>{row.shot.id}</strong><small>{row.shot.visual || row.shot.action || "未填写分镜画面"}</small></div><div className="bulk-video-task-progress"><i><b style={{ width: `${Math.max(0, Math.min(100, row.progress * 100))}%` }} /></i><span>{Math.round(row.progress * 100)}%</span></div><em>{row.status}</em>{row.launch.error || row.record?.error?.message ? <p>{row.launch.error || row.record?.error?.message}</p> : null}</article>)}</div>
      <footer><span>{launching ? "正在创建批量任务，请稍候…" : completed === shots.length ? "本批次任务已全部结束" : "关闭弹窗不会中断后台生成任务"}</span><button className="primary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}

function StoryboardPage({ canonical, projectPath, projectId }: { canonical: CanonicalProject; projectPath: string; projectId: string }) {
  const { locale } = useI18n();
  const { selectedShotId, setSelectedShotId, updateCanonical } = useStudioStore();
  const imageTasks = useProjectImageTasks(projectPath);
  const generationRecords = useProjectGenerationRecords(projectPath);
  const aiSettings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const [showProjectVideo, setShowProjectVideo] = useState(false);
  const [awaitingProjectVideoId, setAwaitingProjectVideoId] = useState("");
  const [showBulkVideoConfirm, setShowBulkVideoConfirm] = useState(false);
  const [showBulkVideoProgress, setShowBulkVideoProgress] = useState(false);
  const [bulkVideoLaunches, setBulkVideoLaunches] = useState<BulkVideoLaunchMap>({});
  const selected = canonical.shots.find((shot) => shot.id === selectedShotId) ?? canonical.shots[0];
  const selectedCharacterIds = selected ? shotCharacterIds(selected) : [];
  const updateShot = (id: string, patch: Partial<Shot>) => updateCanonical((model) => ({ ...model, shots: model.shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot) }));
  const sourceRange = selected?.source_time_range ?? { start: 0, end: selected?.duration ?? 0 };
  const records = generationRecords.data ?? [];
  const projectVideoRecord = records.find((record) => record.media_type === "video" && record.target_type === "project");
  const completedProjectVideoRecord = records.find((record) => record.media_type === "video" && record.target_type === "project" && record.status === "COMPLETED" && record.result_relative_path);
  const projectVideoPath = completedProjectVideoRecord?.result_relative_path;
  const completedShotVideoIds = new Set([
    ...records.filter((record) => record.media_type === "video" && record.target_type === "shot" && record.status === "COMPLETED" && record.result_relative_path).map((record) => record.target_id),
    ...canonical.shots.filter((shot) => Boolean(shot.video_assets?.[0])).map((shot) => shot.id),
  ]);
  const missingShotVideoIds = canonical.shots.filter((shot) => !completedShotVideoIds.has(shot.id)).map((shot) => shot.id);
  const activeShotVideoIds = new Set(records.filter((record) => record.media_type === "video" && record.target_type === "shot" && activeGeneration(record) && !completedShotVideoIds.has(record.target_id)).map((record) => record.target_id));
  const completedShotVideoCount = canonical.shots.filter((shot) => completedShotVideoIds.has(shot.id)).length;
  const activeShotVideoCount = canonical.shots.filter((shot) => activeShotVideoIds.has(shot.id)).length;
  const shotImageRecord = selected ? records.find((record) => record.media_type === "image" && record.target_type === "shot" && record.target_id === selected.id) : undefined;
  const shotVideoRecord = selected ? records.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === selected.id) : undefined;
  const shotImagePath = records.find((record) => record.media_type === "image" && record.target_type === "shot" && record.target_id === selected?.id && record.status === "COMPLETED" && record.result_relative_path)?.result_relative_path ?? selected?.reference_assets?.[0];
  const shotVideoPath = records.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === selected?.id && record.status === "COMPLETED" && record.result_relative_path)?.result_relative_path ?? selected?.video_assets?.[0];
  const selectScene = (sceneId: string) => {
    const scene = canonical.scenes.find((item) => item.id === sceneId);
    const sequence = canonical.sequences.find((item) => item.scene_id === sceneId);
    if (selected && scene) updateShot(selected.id, { scene_id: sceneId, sequence_id: sequence?.id ?? selected.sequence_id, scene_lock: scene.description });
  };
  const selectCharacters = (ids: string[]) => { if (selected) { const stateIds = normalizedShotCharacterStates(ids, selected.character_state_ids, canonical); updateShot(selected.id, { character_ids: ids, character_state_ids: stateIds, character_lock: shotCharacterLockText(ids, stateIds, canonical) }); } };
  const selectCharacterState = (characterId: string, stateId: string) => { if (selected) { const stateIds = { ...normalizedShotCharacterStates(selectedCharacterIds, selected.character_state_ids, canonical), [characterId]: stateId }; updateShot(selected.id, { character_state_ids: stateIds, character_lock: shotCharacterLockText(selectedCharacterIds, stateIds, canonical) }); } };
  const mentionItems: VisualMentionItem[] = [];
  const referenceAssets: GenerationReferenceAssetInput[] = [];
  const tasks = imageTasks.data ?? [];
  if (selected) {
    const scene = canonical.scenes.find((item) => item.id === selected.scene_id);
    const scenePath = scene ? preferredProjectAsset(scene.reference_assets, latestTargetImage(tasks, "scene", scene.id)) : undefined;
    if (scene) mentionItems.push({ id: `scene:${scene.id}`, label: "场景图", detail: `${scene.id} · ${scene.name}${scenePath ? "" : " · 尚未生成图片"}`, insertText: "@场景图", relativePath: scenePath });
    if (scene && scenePath) referenceAssets.push({ relative_path: scenePath, label: `场景“${scene.name}”`, kind: "scene" });
    for (const characterId of selectedCharacterIds) {
      const character = canonical.characters.find((item) => item.id === characterId);
      const characterState = character ? selectedCharacterState(selected, character) : undefined;
      const characterPath = character && characterState ? characterStateImage(character, characterState, tasks) : undefined;
      if (character && characterState) mentionItems.push({ id: `character:${character.id}:${characterState.id}`, label: `${character.name}·${characterState.name}`, detail: `角色状态图 · ${characterState.id}${characterPath ? "" : " · 尚未生成图片"}`, insertText: `@${character.name}·${characterState.name}`, relativePath: characterPath });
      if (character && characterState && characterPath) referenceAssets.push({ relative_path: characterPath, label: `角色“${character.name}”·${characterState.name}`, kind: "character" });
    }
    mentionItems.push({ id: `shot:${selected.id}`, label: "分镜图", detail: `${selected.id}${shotImagePath ? " · 当前分镜生成图" : " · 尚未生成图片"}`, insertText: "@分镜图", relativePath: shotImagePath });
  }
  const imagePrompt = selected ? selected.image_prompt_customized ? selected.image_prompt : defaultShotImagePrompt(selected, canonical) : "";
  const videoPrompt = selected ? selected.video_prompt_customized ? selected.video_prompt : defaultShotVideoPrompt(selected, canonical, referenceAssets, locale) : "";
  const useShotImageAsFirstFrame = Boolean(selected?.use_image_as_video_first_frame);
  const useShotImageAsReference = Boolean(selected?.use_image_as_video_reference && !useShotImageAsFirstFrame);
  const videoGenerationModel = aiSettings.data?.video_generation_model;
  const isSeedanceVideoModel = videoGenerationModel === "kwvideo-v2-ref";
  const isOmniFlashVideoModel = videoGenerationModel === "omni_flash-10s";
  const videoVersion: SeedanceVideoVersion = isSeedanceVideoModel && matchesSeedanceVersion(selected?.video_version) ? selected!.video_version as SeedanceVideoVersion : "标准";
  const supportedVideoResolutions = videoResolutionOptions(videoGenerationModel, videoVersion);
  const videoResolution = selected?.video_resolution && supportedVideoResolutions.includes(selected.video_resolution) ? selected.video_resolution : supportedVideoResolutions[0];
  const videoReferenceAssets: GenerationReferenceAssetInput[] = useShotImageAsReference && shotImagePath
    ? [...referenceAssets, { relative_path: shotImagePath, label: "当前分镜图（视频整体参考图）", kind: "shot_reference" }]
    : referenceAssets;
  const generateImage = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("请先选择分镜");
      updateShot(selected.id, { image_prompt: imagePrompt, image_prompt_customized: true });
      const selection = await requestMediaModel("IMAGE_GENERATION", "选择分镜图生成模型");
      return createImageGenerationTasks({ project_path: projectPath, project_id: projectId, ...mediaImageFields(selection), tasks: [{ target_type: "shot", target_id: selected.id, prompt: imagePrompt, aspect_ratio: canonical.story.aspect_ratio || selected.aspect_ratio || "9:16", reference_assets: referenceAssets }] });
    },
    onSuccess: async () => { await Promise.all([imageTasks.refetch(), generationRecords.refetch()]); },
  });
  const generateVideo = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("请先选择分镜");
      const selection = await requestMediaModel("VIDEO_GENERATION", "选择分镜视频生成模型和分辨率");
      updateShot(selected.id, { video_prompt: videoPrompt, video_prompt_customized: true });
      updateShot(selected.id, { video_resolution: selection.resolution, video_version: undefined });
      return createShotVideoGeneration({ project_path: projectPath, project_id: projectId, shot_id: selected.id, prompt: videoPrompt, aspect_ratio: canonical.story.aspect_ratio || selected.aspect_ratio || "9:16", duration: selected.duration, ...mediaVideoFields(selection), reference_assets: videoReferenceAssets, first_frame_relative_path: useShotImageAsFirstFrame ? shotImagePath : undefined });
    },
    onSuccess: async () => { await generationRecords.refetch(); },
  });
  const bulkVideoGeneration = useMutation({
    mutationFn: async () => {
      const selection = await requestMediaModel("VIDEO_GENERATION", "统一选择全部分镜的视频模型和分辨率");
      const refreshed = await generationRecords.refetch();
      let currentRecords = refreshed.data ?? records;
      for (const shot of canonical.shots) {
        const completedRecord = currentRecords.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path);
        if (completedRecord || shot.video_assets?.[0]) {
          setBulkVideoLaunches((current) => ({ ...current, [shot.id]: { phase: "skipped", recordId: completedRecord?.id } }));
          continue;
        }
        const activeRecord = currentRecords.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && activeGeneration(record));
        if (activeRecord) {
          setBulkVideoLaunches((current) => ({ ...current, [shot.id]: { phase: "existing", recordId: activeRecord.id } }));
          continue;
        }
        setBulkVideoLaunches((current) => ({ ...current, [shot.id]: { phase: "creating" } }));
        try {
          const input = buildShotVideoGenerationInput(shot, canonical, projectPath, projectId, tasks, currentRecords, videoGenerationModel, { locale, mediaSelection: selection });
          updateShot(shot.id, { video_prompt: input.prompt, video_prompt_customized: true, video_resolution: input.resolution, video_version: input.version });
          const record = await createShotVideoGeneration(input);
          setBulkVideoLaunches((current) => ({ ...current, [shot.id]: { phase: "created", recordId: record.id } }));
          const latest = await generationRecords.refetch();
          currentRecords = latest.data ?? [...currentRecords, record];
        } catch (error) {
          const latest = await generationRecords.refetch();
          currentRecords = latest.data ?? currentRecords;
          const racedRecord = currentRecords.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && activeGeneration(record));
          setBulkVideoLaunches((current) => ({ ...current, [shot.id]: racedRecord ? { phase: "existing", recordId: racedRecord.id } : { phase: "failed", error: readableError(error) } }));
        }
      }
    },
    onSettled: async () => { await generationRecords.refetch(); },
  });
  const composeVideo = useMutation({
    mutationFn: () => composeProjectVideo({
      project_path: projectPath,
      project_id: projectId,
      ordered_shot_ids: canonical.shots.map((shot) => shot.id),
      aspect_ratio: canonical.story.aspect_ratio === "16:9" ? "16:9" : "9:16",
    }),
    onSuccess: async (record) => { setAwaitingProjectVideoId(record.id); await generationRecords.refetch(); },
  });
  useEffect(() => {
    if (!awaitingProjectVideoId) return;
    const record = records.find((item) => item.id === awaitingProjectVideoId);
    if (record?.status === "COMPLETED" && record.result_relative_path) {
      setShowProjectVideo(true);
      setAwaitingProjectVideoId("");
    } else if (record?.status === "FAILED") {
      setAwaitingProjectVideoId("");
    }
  }, [awaitingProjectVideoId, records]);
  const startComposition = () => { setShowProjectVideo(false); composeVideo.mutate(); };
  const confirmBulkVideoGeneration = () => {
    const initial: BulkVideoLaunchMap = {};
    for (const shot of canonical.shots) {
      const completedRecord = records.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && record.status === "COMPLETED" && record.result_relative_path);
      const activeRecord = records.find((record) => record.media_type === "video" && record.target_type === "shot" && record.target_id === shot.id && activeGeneration(record));
      initial[shot.id] = completedRecord || shot.video_assets?.[0] ? { phase: "skipped", recordId: completedRecord?.id } : activeRecord ? { phase: "existing", recordId: activeRecord.id } : { phase: "pending" };
    }
    setBulkVideoLaunches(initial);
    setShowBulkVideoConfirm(false);
    setShowBulkVideoProgress(true);
    bulkVideoGeneration.mutate();
  };
  const bulkVideoSessionActive = canonical.shots.some((shot) => {
    const launch = bulkVideoLaunches[shot.id];
    if (!launch) return false;
    if (["pending", "creating", "created", "existing"].includes(launch.phase)) {
      const record = launch.recordId ? records.find((item) => item.id === launch.recordId) : undefined;
      return !record || activeGeneration(record);
    }
    return false;
  });
  const openBulkVideoGeneration = () => bulkVideoGeneration.isPending || bulkVideoSessionActive ? setShowBulkVideoProgress(true) : setShowBulkVideoConfirm(true);
  return <div className="storyboard-layout">
    <section className="project-video-composer">
      <header><div><span className="section-label">PROJECT VIDEO</span><h3>分镜视频合成</h3><p>按照左侧分镜顺序，将每个分镜最新生成成功的视频合成为一个完整视频。</p></div><div className="project-video-actions"><button className="secondary-button batch-video-button" type="button" onClick={openBulkVideoGeneration} disabled={canonical.shots.length === 0 || aiSettings.isLoading}>{bulkVideoGeneration.isPending || bulkVideoSessionActive ? <LoaderCircle className="spin" size={17} /> : <Clapperboard size={17} />}{bulkVideoGeneration.isPending || bulkVideoSessionActive ? "查看批量生成进度" : "一键生成所有分镜视频"}</button>{projectVideoPath && <button className="secondary-button" type="button" onClick={() => setShowProjectVideo(true)}><Play size={17} />播放合成视频</button>}<button className="primary-button" type="button" onClick={startComposition} disabled={composeVideo.isPending || activeGeneration(projectVideoRecord) || canonical.shots.length === 0 || missingShotVideoIds.length > 0}>{composeVideo.isPending || activeGeneration(projectVideoRecord) ? <LoaderCircle className="spin" size={17} /> : <Clapperboard size={17} />}{activeGeneration(projectVideoRecord) ? `正在合成 ${Math.round((projectVideoRecord?.progress ?? 0) * 100)}%` : projectVideoPath ? "重新合成视频" : "一键合成视频"}</button></div></header>
      <div className={missingShotVideoIds.length > 0 ? "project-video-readiness missing" : "project-video-readiness ready"}>{missingShotVideoIds.length > 0 ? <><AlertTriangle size={17} /><span>还有 {missingShotVideoIds.length} 个分镜没有可用视频：{missingShotVideoIds.join("、")}</span></> : <><CheckCircle2 size={17} /><span>全部 {canonical.shots.length} 个分镜视频已就绪，将按当前分镜顺序合成。</span></>}</div>
      {(composeVideo.error || projectVideoRecord?.status === "FAILED") && <div className="error-banner">视频合成失败：{readableError(composeVideo.error ?? projectVideoRecord?.error?.message)}</div>}
    </section>
    {showBulkVideoConfirm && <GenerateAllVideosConfirmModal total={canonical.shots.length} completed={completedShotVideoCount} active={activeShotVideoCount} onCancel={() => setShowBulkVideoConfirm(false)} onConfirm={confirmBulkVideoGeneration} />}
    {showBulkVideoProgress && <GenerateAllVideosProgressModal shots={canonical.shots} records={records} launches={bulkVideoLaunches} launching={bulkVideoGeneration.isPending} onClose={() => setShowBulkVideoProgress(false)} />}
    {showProjectVideo && projectVideoPath && completedProjectVideoRecord && <ProjectVideoPlayerModal projectPath={projectPath} record={completedProjectVideoRecord} aspectRatio={canonical.story.aspect_ratio || "9:16"} shotCount={canonical.shots.length} onClose={() => setShowProjectVideo(false)} />}
    <section className="shot-list"><div className="panel-title"><div><span className="section-label">SHOT LIST</span><h3>{canonical.shots.length} 镜</h3></div><span>{canonical.shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(1)}s</span></div>{canonical.shots.map((shot, index) => <button key={shot.id} className={selected?.id === shot.id ? "shot-row active" : "shot-row"} onClick={() => setSelectedShotId(shot.id)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{shot.id}</strong><small>{shot.action}</small></div><em>{shot.duration}s</em></button>)}</section>
    {selected && <section className="shot-preview">
      <div className="shot-summary"><div><span>SCENE</span><strong>{canonical.scenes.find((scene) => scene.id === selected.scene_id)?.name}</strong></div><div><span>SOURCE</span><strong>{sourceRange.start}–{sourceRange.end}s</strong></div><div><span>RATIO</span><strong>{canonical.story.aspect_ratio || selected.aspect_ratio || "—"}</strong></div></div>
      <div className="shot-content-editor"><div className="panel-title"><div><span className="section-label">SHOT CONTENT</span><h3>分镜内容</h3></div></div><div className="shot-editor-row"><label>画面<VisualMentionEditor value={selected.visual} onChange={(visual) => updateShot(selected.id, { visual })} items={mentionItems} projectPath={projectPath} /></label><label>动作<textarea rows={4} value={selected.action} onChange={(e) => updateShot(selected.id, { action: e.target.value })} /></label></div><div className="shot-editor-row"><label>台词<textarea rows={3} value={selected.dialogue} onChange={(e) => updateShot(selected.id, { dialogue: e.target.value })} /></label><label>声音<textarea rows={3} value={selected.sound} onChange={(e) => updateShot(selected.id, { sound: e.target.value })} /></label></div></div>
      <section className="shot-generation-panel"><div className="shot-prompt-card"><div className="shot-prompt-heading"><div><span className="section-label">STORYBOARD IMAGE</span><strong>分镜图生成提示词</strong></div></div><textarea rows={6} value={imagePrompt} onChange={(event) => updateShot(selected.id, { image_prompt: event.target.value, image_prompt_customized: true })} /><div className="shot-prompt-actions"><div className="shot-image-reference-options"><label className="shot-first-frame-option" title={shotImagePath ? "生成视频时会上传该分镜图，并要求模型从此画面开始运动。" : "请先生成分镜图后再启用。"}><input type="checkbox" checked={useShotImageAsFirstFrame} disabled={!shotImagePath} onChange={(event) => { const checked = event.target.checked; updateShot(selected.id, { use_image_as_video_first_frame: checked, use_image_as_video_reference: checked ? false : useShotImageAsReference, video_prompt: withShotImageInstruction(videoPrompt, checked ? "first_frame" : useShotImageAsReference ? "reference" : undefined), video_prompt_customized: selected.video_prompt_customized }); }} /><span>使用分镜图作为视频首帧</span></label><label className="shot-first-frame-option" title={shotImagePath ? "生成视频时会上传该分镜图，整体参考其角色、场景、构图、光影和风格。" : "请先生成分镜图后再启用。"}><input type="checkbox" checked={useShotImageAsReference} disabled={!shotImagePath} onChange={(event) => { const checked = event.target.checked; updateShot(selected.id, { use_image_as_video_reference: checked, use_image_as_video_first_frame: checked ? false : useShotImageAsFirstFrame, video_prompt: withShotImageInstruction(videoPrompt, checked ? "reference" : useShotImageAsFirstFrame ? "first_frame" : undefined), video_prompt_customized: selected.video_prompt_customized }); }} /><span>使用分镜图作为视频生成参考图</span></label></div><button className="primary-button shot-prompt-action-button" type="button" onClick={() => generateImage.mutate()} disabled={generateImage.isPending || activeGeneration(shotImageRecord)}>{generateImage.isPending || activeGeneration(shotImageRecord) ? <LoaderCircle className="spin" size={14} /> : <ImageIcon size={14} />}{activeGeneration(shotImageRecord) ? `生成中 ${Math.round((shotImageRecord?.progress ?? 0) * 100)}%` : shotImagePath ? "重新生成分镜图" : "生成分镜图"}</button></div></div><div className="shot-prompt-card"><div className="shot-prompt-heading"><div><span className="section-label">STORYBOARD VIDEO</span><strong>视频生成提示词</strong></div></div><textarea rows={6} value={videoPrompt} onChange={(event) => updateShot(selected.id, { video_prompt: event.target.value, video_prompt_customized: true })} /><div className="shot-prompt-actions"><div className="shot-video-options"><small>先选视频清晰度，开始前会告诉你需要多少积分</small></div><button className="primary-button shot-prompt-action-button" type="button" onClick={() => generateVideo.mutate()} disabled={generateVideo.isPending || activeGeneration(shotVideoRecord)}>{generateVideo.isPending || activeGeneration(shotVideoRecord) ? <LoaderCircle className="spin" size={14} /> : <Clapperboard size={14} />}{activeGeneration(shotVideoRecord) ? `生成中 ${Math.round((shotVideoRecord?.progress ?? 0) * 100)}%` : shotVideoPath ? "重新生成视频" : "生成分镜视频"}</button></div></div>{(generateImage.error || shotImageRecord?.status === "FAILED") && <div className="error-banner">分镜图生成失败：{readableError(generateImage.error ?? shotImageRecord?.error?.message)}</div>}{(generateVideo.error || shotVideoRecord?.status === "FAILED") && <div className="error-banner">分镜视频生成失败：{readableError(generateVideo.error ?? shotVideoRecord?.error?.message)}</div>}</section>
      <div className="shot-media-grid"><article className="shot-media-card"><header><span>STORYBOARD IMAGE</span><strong>分镜图</strong></header><div className="shot-media-stage"><ShotGeneratedMedia projectPath={projectPath} relativePath={shotImagePath} mediaType="image" /></div></article><article className="shot-media-card"><header><span>STORYBOARD VIDEO</span><strong>分镜视频</strong></header><div className="shot-media-stage"><ShotGeneratedMedia projectPath={projectPath} relativePath={shotVideoPath} mediaType="video" /></div></article></div>
    </section>}
    {selected && <section className="inspector"><span className="section-label">SHOT INSPECTOR</span><div className="inspector-heading"><h3>{selected.id}</h3><button className={selected.locked ? "lock active" : "lock"} onClick={() => updateShot(selected.id, { locked: !selected.locked })}>{selected.locked ? <Lock size={17} /> : <LockOpen size={17} />}</button></div><div className="inspector-core-grid"><label>时长<input type="number" step="0.5" value={selected.duration} onChange={(e) => updateShot(selected.id, { duration: Number(e.target.value) })} /></label><label>屏幕比例<input readOnly value={canonical.story.aspect_ratio ?? selected.aspect_ratio ?? "9:16"} /></label><label>景别<input value={localizedShotParameter(selected.shot_size, locale)} onChange={(e) => updateShot(selected.id, { shot_size: e.target.value })} /></label><label>机位<input value={localizedShotParameter(selected.camera_angle, locale)} onChange={(e) => updateShot(selected.id, { camera_angle: e.target.value })} /></label></div><label>运镜<input value={localizedShotParameter(selected.camera_movement, locale)} onChange={(e) => updateShot(selected.id, { camera_movement: e.target.value })} /></label><label>画风设定<textarea rows={4} value={selected.visual_style ?? canonical.story.visual_style ?? ""} onChange={(e) => updateShot(selected.id, { visual_style: e.target.value })} /></label><label>场景锁定<select value={selected.scene_id} onChange={(e) => selectScene(e.target.value)}>{canonical.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.id} · {scene.name}</option>)}</select></label><label>人物锁定<select value="" onChange={(e) => { const id = e.target.value; if (id && !selectedCharacterIds.includes(id)) selectCharacters([...selectedCharacterIds, id]); }}><option value="">添加项目角色…</option>{canonical.characters.filter((character) => !selectedCharacterIds.includes(character.id)).map((character) => <option key={character.id} value={character.id}>{character.id} · {character.name}</option>)}</select></label><div className="selected-character-locks">{selectedCharacterIds.map((id) => { const character = canonical.characters.find((item) => item.id === id); const characterState = character ? selectedCharacterState(selected, character) : undefined; const imagePath = character && characterState ? characterStateImage(character, characterState, tasks) : undefined; return character && characterState ? <CharacterLockChip key={id} projectPath={projectPath} characterId={character.id} characterName={character.name + " · " + characterState.name} relativePath={imagePath} onRemove={() => selectCharacters(selectedCharacterIds.filter((item) => item !== id))} /> : null; })}{selectedCharacterIds.length === 0 && <small>该分镜没有锁定人物</small>}</div><div className="shot-character-state-selectors">{selectedCharacterIds.map((characterId) => { const character = canonical.characters.find((item) => item.id === characterId); if (!character) return null; const states = characterStates(character); const currentState = states.find((state) => state.id === selected.character_state_ids?.[characterId]) ?? states[0]!; return <label key={characterId}>{character.name}的状态<select value={currentState.id} onChange={(event) => selectCharacterState(characterId, event.target.value)}>{states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>; })}</div><label>生成约束<textarea rows={3} value={selected.constraints ?? selected.negative_prompt} onChange={(e) => updateShot(selected.id, { constraints: e.target.value, negative_prompt: e.target.value })} /></label></section>}
  </div>;
}

function JobsPage({ bundle }: { bundle: ProjectBundle }) {
  const { t } = useI18n();
  const douyinTasks = useQuery({ queryKey: ["douyin-understanding-tasks"], queryFn: listDouyinUnderstandingTasks, refetchInterval: 1_200 });
  const retryTask = useMutation({ mutationFn: retryDouyinUnderstandingTask, onSuccess: () => douyinTasks.refetch() });
  return <div className="jobs-page-stack"><section className="panel jobs-panel"><div className="panel-title"><div><span className="section-label">PROJECT WORKFLOW</span><h3>{t("taskCenter")}</h3></div><span className="count-badge">{bundle.jobs.length}</span></div>{bundle.jobs.length === 0 ? <div className="empty-state">{t("noTasks")}</div> : bundle.jobs.map((job) => <div className="job-row" key={job.id}><div className="job-icon"><Check size={18} /></div><div><strong>{job.job_type}</strong><span>{job.stage ?? "—"} · {job.id.slice(0, 18)}</span></div><div className="progress"><i style={{ width: `${job.progress * 100}%` }} /></div><em>{job.status}</em></div>)}</section><DouyinTaskList tasks={douyinTasks.data ?? []} loading={douyinTasks.isLoading} retryingTaskId={retryTask.variables} onRetry={(taskId) => retryTask.mutate(taskId)} /></div>;
}
