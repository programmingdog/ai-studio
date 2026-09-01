import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  AiSettings,
  AssetLibraryItem,
  ApplicationLogLevel,
  ApplicationLogListResult,
  CanonicalProject,
  BrowserCookieSource,
  CreateProjectInput,
  CreationSpec,
  DouyinBrowserAvailability,
  DouyinDownloadResult,
  DouyinStoryboardInput,
  CreateDouyinUnderstandingTaskInput,
  DouyinUnderstandingTask,
  DouyinVideoInfo,
  DeleteProjectResult,
  DeleteAssetLibraryResult,
  CreateImageGenerationTasksInput,
  GenerateProjectImageInput,
  GeneratedProjectImage,
  ImageGenerationTask,
  GenerationRecord,
  CreateShotVideoGenerationInput,
  ComposeProjectVideoInput,
  ProjectBundle,
  ProjectListItem,
  Shot,
  SaveAiSettingsInput,
  VideoUnderstandingInput,
  VideoUnderstandingResult,
  LocalVideoMetadata,
  SaveLocalVideoUnderstandingTaskInput,
  CreateLocalVideoUnderstandingTaskInput,
  AutomaticWorkflow,
  CreateAutomaticWorkflowInput,
  UpdateAutomaticWorkflowInput,
  AgentSession,
  AgentMessage,
  AgentRun,
  AgentSendResult,
  IdeaDevelopmentWorkflow,
  UpdateIdeaDevelopmentWorkflowInput,
  CreateVideoRemixTaskInput,
  CreateVideoRemixProjectInput,
  VideoRemixTask,
} from "@aivs/schemas";
import { VIDEO_STORYBOARD_DETAILED_PROMPT, VIDEO_STORYBOARD_PROMPT } from "../prompts/videoStoryboard";
import { CHARACTER_IMAGE_PROMPT } from "../prompts/characterImage";
import { platformApiBaseUrl } from "./apiConfig";

const STORAGE_KEY = "aivs.browser-project";
const isTauri = () => "__TAURI_INTERNALS__" in window;

type LocalAiSettings = Omit<AiSettings, "prompt_defaults">;
type ServerPromptDefaults = {
  source: "SERVER";
  channel: string;
  prompts: Pick<AiSettings, "video_storyboard_prompt" | "video_storyboard_detailed_prompt" | "character_image_prompt">;
  versions: Partial<Record<"video_storyboard_prompt" | "video_storyboard_detailed_prompt" | "character_image_prompt", number>>;
};

async function fetchServerPromptDefaults(): Promise<ServerPromptDefaults | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${platformApiBaseUrl}/client-config/prompts?channel=stable`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const result = await response.json() as ServerPromptDefaults;
    const prompts = result.prompts;
    if (!prompts || [prompts.video_storyboard_prompt, prompts.video_storyboard_detailed_prompt, prompts.character_image_prompt].some((value) => typeof value !== "string" || value.trim().length < 50)) return null;
    return result;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function mergeServerPromptDefaults(local: LocalAiSettings): Promise<AiSettings> {
  const server = await fetchServerPromptDefaults();
  const defaults = server?.prompts || {
    video_storyboard_prompt: local.video_storyboard_prompt || VIDEO_STORYBOARD_PROMPT,
    video_storyboard_detailed_prompt: local.video_storyboard_detailed_prompt || VIDEO_STORYBOARD_DETAILED_PROMPT,
    character_image_prompt: local.character_image_prompt || CHARACTER_IMAGE_PROMPT,
  };
  const overrides = local.prompt_overrides || {
    video_storyboard_prompt: false,
    video_storyboard_detailed_prompt: false,
    character_image_prompt: false,
  };
  return {
    ...local,
    prompt_overrides: overrides,
    video_storyboard_prompt: overrides.video_storyboard_prompt ? local.video_storyboard_prompt : defaults.video_storyboard_prompt,
    video_storyboard_detailed_prompt: overrides.video_storyboard_detailed_prompt ? local.video_storyboard_detailed_prompt : defaults.video_storyboard_detailed_prompt,
    character_image_prompt: overrides.character_image_prompt ? local.character_image_prompt : defaults.character_image_prompt,
    prompt_defaults: {
      ...defaults,
      source: server ? "SERVER" : "LOCAL_CACHE",
      channel: server?.channel || "stable",
      versions: server?.versions || {},
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function store(bundle: ProjectBundle): ProjectBundle {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle));
  return bundle;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectBundle> {
  if (isTauri()) return invoke<ProjectBundle>("create_project", { input });
  const now = new Date().toISOString();
  return store({
    project: {
      id: `P_BROWSER_${Date.now()}`,
      name: input.creation_spec.project_name,
      project_path: `${input.root_path || "Browser Demo"}/${input.creation_spec.project_name}`,
      input_type: input.source_type === "IDEA" ? "IDEA" : "SCRIPT",
      status: "DRAFT",
      created_at: now,
      updated_at: now,
    },
    creation_spec: input.creation_spec,
    source_type: input.source_type,
    source_text: input.source_text ?? "",
    source_path: input.source_path,
    jobs: [],
  });
}

export async function runInitialWorkflow(bundle: ProjectBundle): Promise<ProjectBundle> {
  return bundle.source_type === "IDEA" ? developIdea(bundle) : analyzeScript(bundle);
}

export async function developIdea(bundle: ProjectBundle): Promise<ProjectBundle> {
  if (isTauri()) {
    return invoke<ProjectBundle>("develop_idea", {
      projectPath: bundle.project.project_path,
      projectId: bundle.project.id,
      idea: bundle.source_text,
      creationSpec: bundle.creation_spec,
    });
  }
  await wait(450);
  const job = {
    id: `JOB_BROWSER_${Date.now()}`,
    project_id: bundle.project.id,
    job_type: "DEVELOP_IDEA",
    status: "COMPLETED" as const,
    progress: 1,
    stage: "completed",
  };
  return store({
    ...bundle,
    project: { ...bundle.project, status: "ACTIVE", updated_at: new Date().toISOString() },
    canonical: demoCanonical(bundle.source_text, bundle.creation_spec),
    jobs: [job, ...bundle.jobs],
  });
}

export async function getIdeaDevelopmentWorkflow(projectPath: string, projectId: string): Promise<IdeaDevelopmentWorkflow | null> {
  if (!isTauri()) return null;
  return invoke<IdeaDevelopmentWorkflow | null>("get_idea_development_workflow", { projectPath, projectId });
}

export async function updateIdeaDevelopmentWorkflow(input: UpdateIdeaDevelopmentWorkflowInput): Promise<IdeaDevelopmentWorkflow> {
  if (!isTauri()) throw new Error("浏览器演示模式暂不支持长篇分步创作");
  return invoke<IdeaDevelopmentWorkflow>("update_idea_development_workflow", { input: { ...input, payload: input.payload ?? {} } });
}

export async function analyzeScript(bundle: ProjectBundle): Promise<ProjectBundle> {
  if (isTauri()) {
    return invoke<ProjectBundle>("analyze_script", {
      projectPath: bundle.project.project_path,
      projectId: bundle.project.id,
      sourceText: bundle.source_text,
      sourcePath: bundle.source_path,
      creationSpec: bundle.creation_spec,
    });
  }
  await wait(300);
  const source = bundle.source_text || "浏览器模式无法读取本地剧本文件，请使用 Tauri 桌面模式。";
  return store({
    ...bundle,
    project: { ...bundle.project, status: "ACTIVE", updated_at: new Date().toISOString() },
    canonical: demoCanonical(source.slice(0, 180), bundle.creation_spec),
    jobs: [{ id: `JOB_BROWSER_${Date.now()}`, project_id: bundle.project.id, job_type: "ANALYZE_SCRIPT", status: "COMPLETED", progress: 1, stage: "completed" }, ...bundle.jobs],
  });
}

export async function loadProject(projectPath: string): Promise<ProjectBundle> {
  if (isTauri()) return invoke<ProjectBundle>("load_project", { projectPath });
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) throw new Error("浏览器模式中没有已保存项目");
  return JSON.parse(stored) as ProjectBundle;
}

export async function listProjects(): Promise<ProjectListItem[]> {
  if (isTauri()) return invoke<ProjectListItem[]>("list_projects");
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  const bundle = JSON.parse(stored) as ProjectBundle;
  return [{ ...bundle.project, is_example: false }];
}

export async function deleteProject(projectId: string): Promise<DeleteProjectResult> {
  if (isTauri()) return invoke<DeleteProjectResult>("delete_project", { projectId });
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) throw new Error("项目不存在或已经被移除");
  const bundle = JSON.parse(stored) as ProjectBundle;
  if (bundle.project.id !== projectId) throw new Error("项目不存在或已经被移除");
  localStorage.removeItem(STORAGE_KEY);
  return { project_id: projectId, project_name: bundle.project.name, deleted_path: bundle.project.project_path, preserved_assets: 0 };
}

export async function listAssetLibrary(): Promise<AssetLibraryItem[]> {
  if (isTauri()) return invoke<AssetLibraryItem[]>("list_asset_library");
  return [];
}

export async function deleteAssetLibrary(assetIds: string[]): Promise<DeleteAssetLibraryResult> {
  if (!isTauri()) throw new Error("批量删除资产仅支持桌面应用");
  return invoke<DeleteAssetLibraryResult>("delete_asset_library", { assetIds });
}

export async function resolveDouyinUrl(
  shareText: string,
  browserCookieSource?: BrowserCookieSource,
  cookieFilePath?: string,
): Promise<DouyinVideoInfo> {
  if (!isTauri()) throw new Error("视频链接解析仅支持桌面调试模式");
  return invoke<DouyinVideoInfo>("resolve_douyin_url", { shareText, browserCookieSource, cookieFilePath });
}

export async function resolveDouyinAuto(shareText: string): Promise<DouyinVideoInfo> {
  if (!isTauri()) throw new Error("视频链接自动登录解析仅支持桌面调试模式");
  return invoke<DouyinVideoInfo>("resolve_douyin_auto", { shareText });
}

export async function getDouyinBrowserAvailability(): Promise<DouyinBrowserAvailability> {
  if (!isTauri()) return { chrome: false, edge: false, can_auto_login: false };
  return invoke<DouyinBrowserAvailability>("get_douyin_browser_availability");
}

export async function chooseVideoSavePath(defaultName: string): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await saveDialog({
    title: "保存短视频",
    defaultPath: defaultName,
    filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

export async function saveTextAsTxt(content: string, defaultName: string): Promise<string | undefined> {
  if (!isTauri()) throw new Error("另存为 TXT 仅支持桌面应用");
  const selected = await saveDialog({
    title: "另存为 TXT",
    defaultPath: defaultName,
    filters: [{ name: "TXT 文本", extensions: ["txt"] }],
  });
  if (typeof selected !== "string") return undefined;
  const outputPath = selected.toLowerCase().endsWith(".txt") ? selected : `${selected}.txt`;
  return invoke<string>("save_text_file", { outputPath, content });
}

export async function downloadDouyinVideo(
  shareText: string,
  outputPath: string,
  browserCookieSource?: BrowserCookieSource,
  cookieFilePath?: string,
): Promise<DouyinDownloadResult> {
  return invoke<DouyinDownloadResult>("download_douyin_video", { shareText, outputPath, browserCookieSource, cookieFilePath });
}

export async function downloadDouyinVideoAuto(shareText: string, outputPath: string): Promise<DouyinDownloadResult> {
  return invoke<DouyinDownloadResult>("download_douyin_video_auto", { shareText, outputPath });
}

export async function chooseProjectDirectory(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await openDialog({ directory: true, multiple: false, title: "选择项目保存目录" });
  return typeof selected === "string" ? selected : undefined;
}

export async function chooseScriptFile(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await openDialog({
    multiple: false,
    title: "选择剧本文件",
    filters: [{ name: "剧本文件", extensions: ["txt", "md", "docx", "pdf"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

export async function chooseProjectImage(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await openDialog({
    multiple: false,
    title: "选择项目参考图片",
    filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

export async function importProjectReferenceImage(
  projectPath: string,
  sourcePath: string,
  ownerType: "character_state" | "scene",
  ownerId: string,
): Promise<string> {
  if (!isTauri()) throw new Error("导入本地参考图仅支持桌面应用");
  return invoke<string>("import_project_reference_image", { projectPath, sourcePath, ownerType, ownerId });
}

export async function chooseCookieFile(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await openDialog({
    multiple: false,
    title: "选择 Netscape 格式的 Cookie 文件",
    filters: [{ name: "Cookie 文件", extensions: ["txt", "cookies"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

export async function chooseVideoFile(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const selected = await openDialog({
    multiple: false,
    title: "选择需要理解的视频",
    filters: [{ name: "视频文件", extensions: ["mp4", "m4v", "mpeg", "mpg", "mov", "avi", "flv", "webm", "wmv", "3gp", "3gpp"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

export async function getAiSettings(): Promise<AiSettings> {
  const local: LocalAiSettings = !isTauri() ? {
    base_url: "https://api.lk888.ai", agent_model: "gpt-5.6-sol", video_model: "gemini-3.7-flash", video_storyboard_prompt: VIDEO_STORYBOARD_PROMPT, video_storyboard_detailed_prompt: VIDEO_STORYBOARD_DETAILED_PROMPT, character_image_prompt: CHARACTER_IMAGE_PROMPT, has_api_key: false,
    prompt_overrides: { video_storyboard_prompt: false, video_storyboard_detailed_prompt: false, character_image_prompt: false },
    image_model: "gpt-image-2", image_protocol: "openai",
    video_generation_model: "hailuo-h3-cankaosheng", video_generation_protocol: "media",
    credit_costs: { image_per_item: 1, video_per_second: { default: 2, "480p": 1, "720p": 2, "768P": 2, "1080p": 3, "2K": 5, "4K": 8 } },
    model_catalog: [
      { model: "gpt-5.6-sol", alias: "GPT-5.6 Sol", capability: "agent", protocol: "openai", recommended: true, sort_order: 10 },
      { model: "gemini-3.7-flash", alias: "盘古-3", capability: "video", protocol: "gemini", recommended: false, sort_order: 10 },
      { model: "gpt-image-2", alias: "刑天-2", capability: "image", protocol: "openai", recommended: true, sort_order: 10 },
      { model: "gemini-3-pro-image-preview", alias: "蚩尤-Pro", capability: "image", protocol: "gemini", recommended: false, sort_order: 20 },
      { model: "mj_imagine", alias: "白泽-Pro", capability: "image", protocol: "media", recommended: false, sort_order: 30 },
      { model: "doubao-seedream-5-0-pro-260628", alias: "伏羲5.0-Pro", capability: "image", protocol: "media", recommended: false, sort_order: 40 },
      { model: "hailuo-h3-cankaosheng", alias: "海螺MiniMax-H3", capability: "video_generation", protocol: "media", recommended: false, sort_order: 10 },
      { model: "kwvideo-v2-ref", alias: "Seedance2.0", capability: "video_generation", protocol: "media", recommended: false, sort_order: 20 },
      { model: "omni_flash-10s", alias: "白起-Flash", capability: "video_generation", protocol: "media", recommended: false, sort_order: 30 },
    ],
  } : await invoke<LocalAiSettings>("get_ai_settings");
  return mergeServerPromptDefaults(local);
}

export async function saveAiSettings(input: SaveAiSettingsInput): Promise<AiSettings> {
  if (!isTauri()) throw new Error("API Key 安全存储仅支持桌面应用");
  return mergeServerPromptDefaults(await invoke<LocalAiSettings>("save_ai_settings", { input }));
}

export async function listAgentSessions(): Promise<AgentSession[]> {
  if (!isTauri()) return [];
  return invoke<AgentSession[]>("list_agent_sessions");
}

export async function listAgentMessages(sessionId: string): Promise<AgentMessage[]> {
  if (!isTauri()) return [];
  return invoke<AgentMessage[]>("list_agent_messages", { sessionId });
}

export async function listAgentRuns(sessionId: string): Promise<AgentRun[]> {
  if (!isTauri()) return [];
  return invoke<AgentRun[]>("list_agent_runs", { sessionId });
}

export async function sendAgentMessage(sessionId: string | undefined, message: string): Promise<AgentSendResult> {
  if (!isTauri()) throw new Error("Agent 聊天仅支持桌面应用");
  return invoke<AgentSendResult>("send_agent_message", { input: { session_id: sessionId, message } });
}

export async function analyzeVideo(input: VideoUnderstandingInput): Promise<VideoUnderstandingResult> {
  if (!isTauri()) throw new Error("视频理解仅支持桌面应用");
  return invoke<VideoUnderstandingResult>("analyze_video", { input });
}

export async function probeLocalVideo(videoPath: string): Promise<LocalVideoMetadata> {
  if (!isTauri()) throw new Error("视频信息读取仅支持桌面应用");
  return invoke<LocalVideoMetadata>("probe_local_video", { videoPath });
}

export async function saveLocalVideoUnderstandingTask(input: SaveLocalVideoUnderstandingTaskInput): Promise<DouyinUnderstandingTask> {
  if (!isTauri()) throw new Error("本地视频理解结果仅支持桌面应用");
  return invoke<DouyinUnderstandingTask>("save_local_video_understanding_task", { input });
}

export async function createLocalVideoUnderstandingTask(input: CreateLocalVideoUnderstandingTaskInput): Promise<DouyinUnderstandingTask> {
  if (!isTauri()) throw new Error("本地视频理解任务仅支持桌面应用");
  return invoke<DouyinUnderstandingTask>("create_local_video_understanding_task", { input: { ...input, platform_api_base_url: platformApiBaseUrl } });
}

export async function retryLocalVideoUnderstandingTask(taskId: string): Promise<DouyinUnderstandingTask> {
  if (!isTauri()) throw new Error("本地视频理解任务仅支持桌面应用");
  return invoke<DouyinUnderstandingTask>("retry_local_video_understanding_task", { taskId });
}

export async function deleteVideoUnderstandingTask(taskId: string): Promise<void> {
  if (!isTauri()) throw new Error("视频解析记录删除仅支持桌面应用");
  return invoke<void>("delete_video_understanding_task", { taskId });
}

export async function analyzeDouyinVideo(input: DouyinStoryboardInput): Promise<VideoUnderstandingResult> {
  if (!isTauri()) throw new Error("链接视频分镜生成仅支持桌面应用");
  return invoke<VideoUnderstandingResult>("analyze_douyin_video", { input });
}

export async function createDouyinUnderstandingTask(input: CreateDouyinUnderstandingTaskInput): Promise<DouyinUnderstandingTask> {
  if (!isTauri()) throw new Error("链接视频并发任务仅支持桌面应用");
  return invoke<DouyinUnderstandingTask>("create_douyin_understanding_task", { input: { ...input, platform_api_base_url: platformApiBaseUrl } });
}

export async function listDouyinUnderstandingTasks(): Promise<DouyinUnderstandingTask[]> {
  if (!isTauri()) return [];
  return invoke<DouyinUnderstandingTask[]>("list_douyin_understanding_tasks");
}

export async function listLocalVideoUnderstandingTasks(): Promise<DouyinUnderstandingTask[]> {
  if (!isTauri()) return [];
  return invoke<DouyinUnderstandingTask[]>("list_local_video_understanding_tasks");
}

export async function retryDouyinUnderstandingTask(taskId: string): Promise<DouyinUnderstandingTask> {
  if (!isTauri()) throw new Error("链接视频并发任务仅支持桌面应用");
  return invoke<DouyinUnderstandingTask>("retry_douyin_understanding_task", { taskId });
}

export async function createVideoRemixTask(input: CreateVideoRemixTaskInput): Promise<VideoRemixTask> {
  if (!isTauri()) throw new Error("视频二次创作仅支持桌面应用");
  return invoke<VideoRemixTask>("create_video_remix_task", { input });
}

export async function listVideoRemixTasks(sourceTaskId: string): Promise<VideoRemixTask[]> {
  if (!isTauri()) return [];
  return invoke<VideoRemixTask[]>("list_video_remix_tasks", { sourceTaskId });
}

export async function retryVideoRemixTask(taskId: string): Promise<VideoRemixTask> {
  if (!isTauri()) throw new Error("视频二次创作仅支持桌面应用");
  return invoke<VideoRemixTask>("retry_video_remix_task", { taskId });
}

export async function deleteVideoRemixTask(taskId: string): Promise<void> {
  if (!isTauri()) throw new Error("二次创作记录删除仅支持桌面应用");
  return invoke<void>("delete_video_remix_task", { taskId });
}

export async function createVideoRemixProject(input: CreateVideoRemixProjectInput): Promise<ProjectBundle> {
  if (!isTauri()) throw new Error("视频二次创作项目仅支持桌面应用");
  return invoke<ProjectBundle>("create_video_remix_project", { input });
}

export async function createAutomaticWorkflow(input: CreateAutomaticWorkflowInput): Promise<AutomaticWorkflow> {
  if (!isTauri()) throw new Error("自动制作工作流仅支持桌面应用");
  return invoke<AutomaticWorkflow>("create_automatic_workflow", { input });
}

export async function getActiveAutomaticWorkflow(projectPath: string, projectId: string): Promise<AutomaticWorkflow | null> {
  if (!isTauri()) return null;
  return invoke<AutomaticWorkflow | null>("get_active_automatic_workflow", { projectPath, projectId });
}

export async function updateAutomaticWorkflow(input: UpdateAutomaticWorkflowInput): Promise<AutomaticWorkflow> {
  if (!isTauri()) throw new Error("自动制作工作流仅支持桌面应用");
  return invoke<AutomaticWorkflow>("update_automatic_workflow", { input });
}

export async function generateProjectImage(_input: GenerateProjectImageInput): Promise<GeneratedProjectImage> {
  throw new Error("旧版生图方式已停用，请重新选择生成方案，确认积分后再开始");
}

export async function createImageGenerationTasks(input: CreateImageGenerationTasksInput): Promise<ImageGenerationTask[]> {
  if (!isTauri()) throw new Error("后台生图任务仅支持桌面应用");
  return invoke<ImageGenerationTask[]>("create_image_generation_tasks", { input });
}

export async function listImageGenerationTasks(projectPath: string): Promise<ImageGenerationTask[]> {
  if (!isTauri()) return [];
  return invoke<ImageGenerationTask[]>("list_image_generation_tasks", { projectPath });
}

export async function resumeImageGenerationTasks(projectPath: string): Promise<ImageGenerationTask[]> {
  if (!isTauri()) return [];
  return invoke<ImageGenerationTask[]>("resume_image_generation_tasks", { projectPath });
}

export async function listGenerationRecords(projectPath: string): Promise<GenerationRecord[]> {
  if (!isTauri()) return [];
  return invoke<GenerationRecord[]>("list_generation_records", { projectPath });
}

export async function listApplicationLogs(
  level: "all" | ApplicationLogLevel = "all",
  options?: { startTime?: string; endTime?: string; limit?: number },
): Promise<ApplicationLogListResult> {
  if (!isTauri()) return { directory: "", entries: [], truncated: false };
  return invoke<ApplicationLogListResult>("list_application_logs", {
    level,
    limit: options?.limit ?? 2000,
    startTime: options?.startTime,
    endTime: options?.endTime,
  });
}

export interface ExportGenerationAssetsResult {
  output_directory: string;
  exported_files: string[];
  skipped_count: number;
}

function generationResultFileName(record: GenerationRecord): string {
  const fileName = record.result_relative_path?.split(/[\\/]/).pop();
  return fileName || `${record.target_id || "generated-media"}.${record.media_type === "video" ? "mp4" : "png"}`;
}

export async function saveGenerationRecordAsset(projectPath: string, record: GenerationRecord): Promise<string | undefined> {
  if (!isTauri()) throw new Error("生成结果另存仅支持桌面应用");
  if (record.status !== "COMPLETED" || !record.result_relative_path) throw new Error("该生成记录暂无可保存的结果文件");
  const defaultName = generationResultFileName(record);
  const extension = defaultName.includes(".") ? defaultName.split(".").pop()!.toLowerCase() : record.media_type === "video" ? "mp4" : "png";
  const selected = await saveDialog({
    title: record.media_type === "video" ? "另存生成视频" : "另存生成图片",
    defaultPath: defaultName,
    filters: [{ name: record.media_type === "video" ? "视频文件" : "图片文件", extensions: [extension] }],
  });
  if (typeof selected !== "string") return undefined;
  const outputPath = selected.toLowerCase().endsWith(`.${extension}`) ? selected : `${selected}.${extension}`;
  return invoke<string>("save_generation_record_asset", { projectPath, recordId: record.id, outputPath });
}

export async function exportAllGenerationAssets(projectPath: string): Promise<ExportGenerationAssetsResult | undefined> {
  if (!isTauri()) throw new Error("生成结果批量保存仅支持桌面应用");
  const selected = await openDialog({ directory: true, multiple: false, title: "选择全部生成结果的保存文件夹" });
  if (typeof selected !== "string") return undefined;
  return invoke<ExportGenerationAssetsResult>("export_all_generation_assets", { projectPath, outputDirectory: selected });
}

export async function createShotVideoGeneration(input: CreateShotVideoGenerationInput): Promise<GenerationRecord> {
  if (!isTauri()) throw new Error("分镜视频生成仅支持桌面应用");
  return invoke<GenerationRecord>("create_shot_video_generation", { input });
}

export async function composeProjectVideo(input: ComposeProjectVideoInput): Promise<GenerationRecord> {
  if (!isTauri()) throw new Error("视频合成仅支持桌面应用");
  return invoke<GenerationRecord>("compose_project_video", { input });
}

export async function readProjectAsset(projectPath: string, relativePath: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("read_project_asset", { projectPath, relativePath });
}

export async function saveCanonical(bundle: ProjectBundle): Promise<ProjectBundle> {
  if (!bundle.canonical) throw new Error("没有可保存的 Canonical Model");
  if (isTauri()) {
    return invoke<ProjectBundle>("save_canonical_project", {
      projectPath: bundle.project.project_path,
      projectId: bundle.project.id,
      canonical: bundle.canonical,
    });
  }
  await wait(120);
  return store({ ...bundle, project: { ...bundle.project, updated_at: new Date().toISOString() } });
}

function demoCanonical(idea: string, spec: CreationSpec): CanonicalProject {
  const characters = [
    ["林小凡", "PROTAGONIST", "困境中的普通人"],
    ["周晴", "ALLY", "敏锐的调查记者"],
    ["高老板", "ANTAGONIST", "精于算计的操盘者"],
    ["老陈", "MENTOR", "神秘的修理铺老板"],
    ["小雨", "EMOTIONAL_ANCHOR", "主角珍视的妹妹"],
  ].map(([name, role, storyFunction], index) => ({
    id: `CHAR_${String(index + 1).padStart(3, "0")}`,
    name: name!, role: role!, gender: "", age_range: "20-35",
    appearance: { face: "辨识度清晰的东方面孔", hair: "符合职业", body: "自然比例", clothes: "都市日常服装", accessories: "角色专属小件" },
    voice: "自然普通话",
    appearance_lock: "辨识度清晰的东方面孔，符合职业的发型，自然身形比例",
    clothing_lock: "都市日常服装与角色专属小件，跨镜头保持一致",
    voice_lock: "自然、有辨识度的普通话",
    story_function: storyFunction!, locked: false, reference_assets: [],
  }));
  const sceneSpecs = [
    ["雨夜街道", "NIGHT"], ["狭小出租屋", "NIGHT"], ["老城区修理铺", "DAY"],
    ["商业中心天台", "SUNSET"], ["废弃物流仓库", "NIGHT"], ["清晨江边", "DAWN"],
  ];
  const scenes = sceneSpecs.map(([name, time], index) => ({
    id: `SCENE_${String(index + 1).padStart(3, "0")}`, name: name!, location_type: index % 2 ? "INTERIOR" : "EXTERIOR",
    time_of_day: time!, description: `${name}，空间关系清晰且可重复使用`, lighting: "电影化层次光",
    layout: "固定入口、主体区和背景层次", props: ["剧情线索", "生活陈设"], mood: "紧张而神秘", locked: false, reference_assets: [],
  }));
  const actions = ["异常征兆出现", "主角救下路人", "发现力量限制", "回家隐瞒变化", "新闻带来线索", "来到修理铺", "导师说明代价", "记者介入调查", "反派确认身份", "测试能力边界", "倒计时逼近", "盟友发生冲突", "家人成为诱饵", "仓库正面交锋", "只剩十分钟", "智慧弥补限制", "阴谋被公开", "主角作出选择", "众人重新理解彼此", "新的异常信号出现"];
  const totalDuration = Math.max(5, spec.target_duration);
  const shotCount = totalDuration <= 15 ? 1 : totalDuration < 20 ? 2 : Math.max(2, Math.floor(totalDuration / 10));
  const baseDuration = totalDuration / shotCount;
  const durations = Array.from({ length: shotCount }, (_, index) => index === shotCount - 1 ? Number((totalDuration - Number(baseDuration.toFixed(2)) * (shotCount - 1)).toFixed(2)) : Number(baseDuration.toFixed(2)));
  const localParameter = (value: string) => {
    const simplified: Record<string, string> = { WIDE: "全景", MEDIUM: "中景", CLOSE_UP: "近景", EYE_LEVEL: "平视", STATIC: "固定", SLOW_PUSH_IN: "缓慢推进", HANDHELD_FOLLOW: "手持跟拍" };
    const traditional: Record<string, string> = { WIDE: "全景", MEDIUM: "中景", CLOSE_UP: "近景", EYE_LEVEL: "平視", STATIC: "固定", SLOW_PUSH_IN: "緩慢推進", HANDHELD_FOLLOW: "手持跟拍" };
    const english: Record<string, string> = { WIDE: "Wide", MEDIUM: "Medium", CLOSE_UP: "Close-up", EYE_LEVEL: "Eye level", STATIC: "Static", SLOW_PUSH_IN: "Slow push-in", HANDHELD_FOLLOW: "Handheld tracking" };
    return (spec.language === "zh-TW" ? traditional : spec.language === "zh-CN" ? simplified : english)[value] ?? value;
  };
  const shots: Shot[] = durations.map((duration, index) => {
    const action = actions[index % actions.length]!;
    const sceneNumber = Math.min(6, Math.floor(index / 4) + 1);
    const start = durations.slice(0, index).reduce((sum, value) => sum + value, 0);
    const midpoint = Number((duration / 2).toFixed(2));
    const visual = `0～${midpoint}秒：建立当前人物、场景与动作状态。\n${midpoint}～${duration}秒：${action}，完成本分镜。`;
    return {
      id: `A-${String(index + 1).padStart(3, "0")}`, sequence_id: `SEQ_${String(sceneNumber).padStart(3, "0")}`,
      scene_id: `SCENE_${String(sceneNumber).padStart(3, "0")}`, character_ids: ["CHAR_001"],
      source_time_range: { start, end: start + duration },
      duration, shot_size: localParameter(["WIDE", "MEDIUM", "CLOSE_UP"][index % 3]!),
      aspect_ratio: spec.aspect_ratio,
      camera_angle: localParameter("EYE_LEVEL"), camera_movement: localParameter(["STATIC", "SLOW_PUSH_IN", "HANDHELD_FOLLOW"][index % 3]!),
      visual_style: spec.visual_style, scene_lock: "保持场景空间、光线、陈设和方位关系一致", character_lock: "CHAR_001 的外貌、服装和声音保持一致",
      visual, action, emotion: "由疑惑转为坚定", dialogue: index % 3 === 2 ? "我必须在时间结束前做出选择。" : "",
      sound: "城市环境音与克制配乐", image_prompt: `画面：${visual}\n项目画风：${spec.visual_style}`, video_prompt: `运镜：${localParameter(["STATIC", "SLOW_PUSH_IN", "HANDHELD_FOLLOW"][index % 3]!)}\n画面：${visual}\n动作：${action}\n台词：${index % 3 === 2 ? "我必须在时间结束前做出选择。" : "无"}\n声音：城市环境音与克制配乐\n约束：角色与场景保持一致，无畸形，无文字水印\n项目画风：${spec.visual_style}`,
      negative_prompt: "角色不一致，多余手指，畸形肢体，文字水印", constraints: "角色不一致，多余手指，畸形肢体，文字水印", status: "DRAFT", locked: false,
    };
  });
  const sequences = scenes.map((scene, index) => ({
    id: `SEQ_${String(index + 1).padStart(3, "0")}`, scene_id: scene.id, order: index + 1,
    summary: `在${scene.name}推进剧情`, character_ids: ["CHAR_001"], shot_ids: shots.filter((shot) => shot.scene_id === scene.id).map((shot) => shot.id),
  }));
  return {
    story: {
      title: spec.project_name, logline: `${idea}，但每一次选择都让他更接近必须承担的代价。`, genre: [spec.creative_type_name, spec.creative_type_category].filter((value): value is string => Boolean(value)),
      theme: "人物在核心冲突中作出选择并承担代价", synopsis: `以“${spec.creative_type_name || "原创剧情"}”类型开发创意“${idea}”。`, tone: `遵循${spec.creative_type_name || "项目"}的经典叙事气质与节奏`,
      aspect_ratio: spec.aspect_ratio, visual_style: spec.visual_style,
    }, episodes: [], characters, scenes, sequences, shots,
  };
}
