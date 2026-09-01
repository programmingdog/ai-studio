export type InputType = "VIDEO" | "SCRIPT" | "IDEA";
export type CreationMode = "QUICK" | "DIRECTOR" | "PROFESSIONAL";
export type Lockable = { locked: boolean };

export interface CreationSpec {
  project_name: string;
  input_type: InputType;
  target_duration: number;
  aspect_ratio: string;
  content_type: string;
  visual_style: string;
  target_platform: string;
  language: string;
  creation_mode: CreationMode;
  /** Selected creative genre preset for idea development. */
  creative_type_id?: string;
  creative_type_category?: string;
  creative_type_name?: string;
  creative_type_prompt?: string;
  /** Preferred episode generation unit for the guided idea workflow. */
  long_form_chunk_seconds?: 60 | 90;
}

export type IdeaDevelopmentStage = "outline_review" | "episodes_review" | "assets_review" | "storyboards" | "storyboards_review" | "completed" | "failed";

export interface Episode {
  id: string;
  order: number;
  title: string;
  duration: number;
  content: string;
}

export interface IdeaDevelopmentWorkflow {
  id: string;
  project_id: string;
  status: "RUNNING" | "WAITING_INPUT" | "FAILED" | "COMPLETED" | "CANCELLED";
  stage: IdeaDevelopmentStage;
  progress: number;
  message: string;
  target_duration: number;
  chunk_duration: number;
  snapshot: {
    story?: Story;
    episodes?: Episode[];
    characters?: Character[];
    scenes?: Scene[];
    completed_episode_storyboards?: unknown[];
    continuity_state?: unknown;
    canonical_summary?: { characters?: number; scenes?: number; shots?: number; duration?: number };
  };
  error?: { code?: string; message?: string; retryable?: boolean };
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export type IdeaDevelopmentAction =
  | "save_outline" | "regenerate_outline" | "confirm_outline" | "retry_outline"
  | "save_episodes" | "regenerate_episodes" | "confirm_episodes" | "retry_episodes"
  | "save_assets" | "regenerate_assets" | "confirm_assets" | "retry_assets"
  | "regenerate_storyboards" | "confirm_storyboards" | "retry_storyboards" | "cancel";

export interface UpdateIdeaDevelopmentWorkflowInput {
  project_path: string;
  project_id: string;
  workflow_id: string;
  action: IdeaDevelopmentAction;
  payload?: Record<string, unknown>;
}

export interface StoryBeat {
  id: string;
  type: string;
  description: string;
}

export interface Story {
  title: string;
  logline: string;
  genre: string[];
  theme: string;
  synopsis: string;
  tone: string;
  aspect_ratio?: "9:16" | "16:9" | string;
  visual_style?: string;
  beats?: StoryBeat[];
}

export interface Character extends Lockable {
  id: string;
  name: string;
  role: string;
  gender: string;
  age_range: string;
  appearance: {
    face: string;
    hair: string;
    body: string;
    clothes: string;
    accessories: string;
  };
  personality?: string;
  motivation?: string;
  voice: string;
  /** Stable visual description extracted from video understanding. */
  appearance_lock?: string;
  /** Stable wardrobe description extracted from video understanding. */
  clothing_lock?: string;
  /** Stable voice description extracted from video understanding. */
  voice_lock?: string;
  story_function: string;
  reference_assets: string[];
  /** Visual forms used only for clear clothing, carried-prop/equipment, or age changes. */
  states?: CharacterState[];
}

export interface CharacterState extends Lockable {
  id: string;
  name: string;
  /** Story condition that activates this visual form. */
  trigger: string;
  description: string;
  appearance_lock: string;
  clothing_lock: string;
  reference_assets: string[];
}

export interface Scene extends Lockable {
  id: string;
  name: string;
  location_type: string;
  time_of_day: string;
  description: string;
  lighting: string;
  layout: string;
  props: string[];
  mood: string;
  reference_assets: string[];
}

export interface Sequence {
  id: string;
  scene_id: string;
  order: number;
  summary: string;
  character_ids: string[];
  shot_ids: string[];
}

export interface Shot extends Lockable {
  id: string;
  sequence_id: string;
  scene_id: string;
  character_ids: string[];
  /** Selected visual state for each character in this shot: character id -> state id. */
  character_state_ids?: Record<string, string>;
  /** Original video segment represented by this shot, in seconds. */
  source_time_range?: {
    start: number;
    end: number;
  };
  duration: number;
  aspect_ratio?: string;
  shot_size: string;
  camera_angle: string;
  camera_movement: string;
  visual_style?: string;
  scene_lock?: string;
  character_lock?: string;
  visual: string;
  action: string;
  emotion: string;
  dialogue: string;
  sound: string;
  image_prompt: string;
  image_prompt_customized?: boolean;
  video_prompt: string;
  video_prompt_customized?: boolean;
  video_resolution?: string;
  video_version?: string;
  use_image_as_video_first_frame?: boolean;
  use_image_as_video_reference?: boolean;
  negative_prompt: string;
  constraints?: string;
  /** Generated or imported storyboard images available for @ references. */
  reference_assets?: string[];
  /** Generated storyboard videos persisted with this shot. */
  video_assets?: string[];
  status: string;
}

export interface CanonicalProject {
  story: Story;
  episodes: Episode[];
  characters: Character[];
  scenes: Scene[];
  sequences: Sequence[];
  shots: Shot[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  project_path: string;
  input_type: InputType;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectListItem extends ProjectSummary {
  is_example: boolean;
}

export type AssetLibraryType = "scene" | "character" | "prop";

export interface AssetLibraryItem {
  id: string;
  asset_type: AssetLibraryType;
  name: string;
  prompt: string;
  image_path: string;
  source_project_id?: string;
  source_project_path?: string;
  source_target_type?: string;
  source_target_id?: string;
  created_at: string;
  updated_at: string;
}

export interface DeleteAssetLibraryResult {
  deleted_count: number;
  deleted_ids: string[];
}

export interface DeleteProjectResult {
  project_id: string;
  project_name: string;
  deleted_path: string;
  preserved_assets: number;
}

export type BrowserCookieSource = "edge" | "chrome" | "firefox";

export interface DouyinBrowserAvailability {
  chrome: boolean;
  edge: boolean;
  can_auto_login: boolean;
  preferred?: "chrome" | "edge";
}

export interface DouyinVideoInfo {
  id: string;
  title: string;
  uploader: string;
  duration?: number;
  thumbnail?: string;
  webpage_url: string;
  download_url: string;
  ext: string;
  width?: number;
  height?: number;
  format_id?: string;
  extractor: string;
  platform?: "DOUYIN" | "KUAISHOU" | "BILIBILI" | "UNKNOWN";
  platform_name?: string;
}

export interface DouyinDownloadResult {
  saved_path: string;
  size_bytes: number;
}

export interface AiSettings {
  base_url: string;
  agent_model: string;
  video_model: string;
  video_storyboard_prompt: string;
  video_storyboard_detailed_prompt: string;
  character_image_prompt: string;
  prompt_defaults: PromptDefaultSettings;
  prompt_overrides: PromptOverrideSettings;
  image_model: string;
  image_protocol: ImageApiProtocol;
  video_generation_model: string;
  video_generation_protocol: VideoGenerationApiProtocol;
  credit_costs: CreditCostSettings;
  model_catalog: AiModelCatalogItem[];
  has_api_key: boolean;
  api_key_mask?: string;
}

export interface PromptOverrideSettings {
  video_storyboard_prompt: boolean;
  video_storyboard_detailed_prompt: boolean;
  character_image_prompt: boolean;
}

export interface PromptDefaultSettings {
  source: "SERVER" | "LOCAL_CACHE";
  channel: string;
  versions: Partial<Record<keyof PromptOverrideSettings, number>>;
  video_storyboard_prompt: string;
  video_storyboard_detailed_prompt: string;
  character_image_prompt: string;
}

export interface CreativeTypePreset {
  id: string;
  category: "电影" | "电视剧" | "科幻奇幻" | "竖屏短剧" | "漫剧" | string;
  name: string;
  description: string;
  prompt: string;
}

export interface AiModelCatalogItem {
  model: string;
  alias: string;
  capability: "agent" | "video" | "image" | "video_generation";
  protocol: ImageApiProtocol | VideoGenerationApiProtocol | "gemini";
  recommended: boolean;
  sort_order: number;
}

export interface SaveAiSettingsInput {
  base_url: string;
  agent_model: string;
  video_model: string;
  video_storyboard_prompt: string;
  video_storyboard_detailed_prompt: string;
  character_image_prompt: string;
  prompt_overrides: PromptOverrideSettings;
  image_model: string;
  image_protocol: ImageApiProtocol;
  video_generation_model: string;
  video_generation_protocol: VideoGenerationApiProtocol;
  credit_costs: CreditCostSettings;
  api_key?: string;
  clear_api_key?: boolean;
}

export interface AgentSession {
  id: string;
  title: string;
  project_id?: string;
  project_path?: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AgentRun {
  id: string;
  session_id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | string;
  stage: string;
  progress: number;
  model: string;
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  error?: { message?: string; [key: string]: unknown };
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface AgentClientAction {
  type: "open_project" | "open_project_and_start_production";
  project_id: string;
  project_path: string;
  production_mode?: "none" | "fast" | "storyboard";
  resolution?: string;
}

export interface AgentSendResult {
  session: AgentSession;
  message: AgentMessage;
  run: AgentRun;
  action?: AgentClientAction;
}

export type VideoCreditResolution = "default" | "480p" | "720p" | "768P" | "1080p" | "2K" | "4K";

export interface CreditCostSettings {
  image_per_item: number;
  video_per_second: Record<VideoCreditResolution, number>;
}

export type ImageApiProtocol = "openai" | "gemini" | "media";
export type VideoGenerationApiProtocol = "media";

export interface GenerateProjectImageInput {
  project_path: string;
  target_type: "character" | "scene";
  target_id: string;
  prompt: string;
  aspect_ratio: string;
}

export interface GeneratedProjectImage {
  relative_path: string;
  absolute_path: string;
  model: string;
  protocol: ImageApiProtocol;
  prompt: string;
  preview_data_url: string;
}

export type ImageGenerationTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "REMOTE_PROCESSING"
  | "DOWNLOADING"
  | "COMPLETED"
  | "FAILED";

export interface ImageGenerationTask {
  id: string;
  project_id: string;
  target_type: "character" | "character_state" | "scene" | "shot";
  target_id: string;
  base_url: string;
  model: string;
  protocol: ImageApiProtocol;
  prompt: string;
  aspect_ratio: string;
  status: ImageGenerationTaskStatus;
  progress: number;
  remote_task_id?: string;
  result_relative_path?: string;
  result_absolute_path?: string;
  result_mime_type?: string;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: string };
  retry_count: number;
  created_at: string;
  started_at?: string;
  updated_at: string;
  finished_at?: string;
}

export interface CreateImageGenerationTaskItem {
  target_type: "character" | "character_state" | "scene" | "shot";
  target_id: string;
  prompt: string;
  aspect_ratio: string;
  reference_assets?: GenerationReferenceAssetInput[];
}

export interface GenerationReferenceAssetInput {
  relative_path: string;
  label: string;
  kind: "scene" | "character" | "shot_first_frame" | "shot_reference";
}

export type GenerationMediaType = "image" | "video";

export interface GenerationRecord {
  id: string;
  project_id: string;
  media_type: GenerationMediaType;
  target_type: "character" | "character_state" | "scene" | "shot" | "project";
  target_id: string;
  base_url: string;
  model: string;
  protocol: string;
  prompt: string;
  aspect_ratio: string;
  status: ImageGenerationTaskStatus;
  progress: number;
  remote_task_id?: string;
  result_relative_path?: string;
  result_absolute_path?: string;
  result_mime_type?: string;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: string };
  retry_count: number;
  created_at: string;
  started_at?: string;
  updated_at: string;
  finished_at?: string;
}

export type AutomaticWorkflowMode = "fast" | "storyboard";
export type AutomaticWorkflowStage = "assets" | "storyboard" | "video" | "composition" | "completed";

export interface AutomaticWorkflowTaskSnapshot {
  id: string;
  media_type: "image" | "video";
  target_type: "scene" | "character" | "character_state" | "shot" | "project";
  target_id: string;
  status: ImageGenerationTaskStatus;
  progress: number;
  result_relative_path?: string;
  error?: { message?: string; code?: string };
}

export interface AutomaticWorkflow {
  id: string;
  project_id: string;
  mode: AutomaticWorkflowMode;
  resolution: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED";
  stage: AutomaticWorkflowStage;
  progress: number;
  message: string;
  retry_message?: string;
  snapshot: AutomaticWorkflowSnapshot;
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface CreateAutomaticWorkflowInput {
  project_path: string;
  project_id: string;
  mode: AutomaticWorkflowMode;
  resolution: string;
}

export interface UpdateAutomaticWorkflowInput {
  project_path: string;
  project_id: string;
  workflow_id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED";
  stage: AutomaticWorkflowStage;
  progress: number;
  message: string;
  retry_message?: string;
  snapshot: AutomaticWorkflowSnapshot;
}

export interface AutomaticWorkflowMediaSelection { provider_model_id: string; model_alias: string; model_code?: string; resolution: string; credit_cost: number; workflow_credit_id?: string }
export interface AutomaticWorkflowSnapshot {
  items?: AutomaticWorkflowTaskSnapshot[];
  image_model?: AutomaticWorkflowMediaSelection;
  video_model?: AutomaticWorkflowMediaSelection;
}

export type ApplicationLogLevel = "critical" | "error" | "info" | "debug";

export interface ApplicationLogEntry {
  timestamp: string;
  level: ApplicationLogLevel;
  event: string;
  details: Record<string, unknown> | unknown;
}

export interface ApplicationLogListResult {
  directory: string;
  entries: ApplicationLogEntry[];
  truncated: boolean;
}

export interface CreateShotVideoGenerationInput {
  workflow_credit_id?: string;
  project_path: string;
  project_id: string;
  shot_id: string;
  prompt: string;
  aspect_ratio: string;
  duration: number;
  resolution?: string;
  version?: string;
  reference_assets: GenerationReferenceAssetInput[];
  first_frame_relative_path?: string;
  platform_api_base_url: string;
  provider_model_id: string;
  model_alias: string;
}

export interface ComposeProjectVideoInput {
  project_path: string;
  project_id: string;
  ordered_shot_ids: string[];
  aspect_ratio: "9:16" | "16:9";
}

export interface CreateImageGenerationTasksInput {
  workflow_credit_id?: string;
  project_path: string;
  project_id: string;
  platform_api_base_url: string;
  provider_model_id: string;
  model_alias: string;
  resolution: string;
  tasks: CreateImageGenerationTaskItem[];
}

export interface VisualStylePreset {
  id: string;
  category: "电影" | "短剧" | "漫剧" | string;
  name: string;
  description: string;
  prompt: string;
}

export interface VideoUnderstandingInput {
  video_path: string;
  prompt: string;
}

export interface VideoUnderstandingResult {
  text: string;
  model: string;
  upload_mode: "inline" | "files-api" | "server-url" | "server-upload";
  video_name: string;
  size_bytes: number;
}

export interface LocalVideoMetadata {
  duration: number;
  width: number;
  height: number;
  aspect_ratio: "9:16" | "16:9";
  size_bytes: number;
}

export interface DouyinStoryboardInput {
  share_text: string;
  prompt: string;
  source_width?: number;
  source_height?: number;
  aspect_ratio?: "9:16" | "16:9";
  managed?: boolean;
  browser_cookie_source?: BrowserCookieSource;
  cookie_file_path?: string;
}

export type DouyinUnderstandingTaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface DouyinUnderstandingTask {
  id: string;
  source_kind?: "LINK" | "LOCAL";
  share_text: string;
  title: string;
  uploader: string;
  platform?: DouyinVideoInfo["platform"];
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
  aspect_ratio?: "9:16" | "16:9";
  mode: "standard" | "detailed" | "fixed";
  fixed_seconds?: number;
  status: DouyinUnderstandingTaskStatus;
  stage: string;
  progress: number;
  message: string;
  result?: VideoUnderstandingResult;
  error?: { code?: string; message: string; retryable?: boolean };
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface CreateDouyinUnderstandingTaskInput extends DouyinStoryboardInput {
  video_info: DouyinVideoInfo;
  mode: DouyinUnderstandingTask["mode"];
  fixed_seconds?: number;
}

export interface SaveLocalVideoUnderstandingTaskInput {
  video_path: string;
  mode: DouyinUnderstandingTask["mode"];
  fixed_seconds?: number;
  duration?: number;
  aspect_ratio?: "9:16" | "16:9";
  result: VideoUnderstandingResult;
}

export interface CreateLocalVideoUnderstandingTaskInput {
  video_path: string;
  prompt: string;
  mode: DouyinUnderstandingTask["mode"];
  fixed_seconds?: number;
}

export type VideoRemixOriginality = "balanced" | "high" | "radical";
export type VideoRemixStoryboardDurationMode = "fixed" | "adaptive";
export type VideoRemixTaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface VideoRemixResult {
  title: string;
  logline: string;
  synopsis: string;
  adaptation_notes: {
    source_structure: string[];
    conflict_design: string[];
    reversal_design: string[];
    originality_statement: string;
  };
  canonical: CanonicalProject;
}

export interface CreateVideoRemixTaskInput {
  source_task_id: string;
  project_name: string;
  creative_direction: string;
  originality: VideoRemixOriginality;
  storyboard_duration_mode: VideoRemixStoryboardDurationMode;
  target_duration: number;
  aspect_ratio: "9:16" | "16:9";
  visual_style: string;
  language: string;
}

export interface VideoRemixTask {
  id: string;
  source_task_id: string;
  project_name: string;
  status: VideoRemixTaskStatus;
  stage: string;
  progress: number;
  message: string;
  input: CreateVideoRemixTaskInput;
  result?: VideoRemixResult;
  error?: { code?: string; message: string; retryable?: boolean };
  project_path?: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface CreateVideoRemixProjectInput {
  remix_task_id: string;
  root_path: string;
  project_name: string;
}

export interface Job {
  id: string;
  project_id?: string;
  job_type: string;
  status: JobStatus;
  progress: number;
  stage?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export type JobStatus =
  | "PENDING"
  | "PREPARING"
  | "RUNNING"
  | "UPLOADING"
  | "REMOTE_PROCESSING"
  | "DOWNLOADING"
  | "POST_PROCESSING"
  | "QC"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "PAUSED"
  | "WAITING_NETWORK"
  | "WAITING_CREDIT"
  | "WAITING_LICENSE";

export interface ProjectBundle {
  project: ProjectSummary;
  creation_spec: CreationSpec;
  source_type: ProjectSourceType;
  source_text: string;
  source_path?: string;
  canonical?: CanonicalProject;
  jobs: Job[];
  image_tasks?: ImageGenerationTask[];
}

export type ProjectSourceType = "IDEA" | "SCRIPT_TEXT" | "SCRIPT_FILE";

export interface CreateProjectInput {
  root_path: string;
  source_type: ProjectSourceType;
  source_text?: string;
  source_path?: string;
  creation_spec: CreationSpec;
}
