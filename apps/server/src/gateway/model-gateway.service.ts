import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { parseStoredJson } from "../common/input";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";
import { resolveMediaResolution, supportsMediaResolution } from "./media-resolution";
import { wagaMediaParams, wagaProfiles, wagaTaskStatus } from "./waga-media";
import { WagaModelMetadataService } from "../common/waga-model-metadata.service";
import { ModelCreditMultiplierService, multiplierFor, multiplyCredits } from "../common/model-credit-multiplier.service";

interface TargetRow extends RowDataPacket {
  provider_id: string; provider_code: string; base_url: string; provider_config_json: unknown;
  model_id: string; model_code: string; model_alias: string; capability: string; api_protocol: string;
  generation_endpoint: string; query_endpoint: string | null; credit_cost: number | string;
  supports_async_tasks: number; model_config_json: unknown; parameter_schema_json: unknown; credential_id: string; api_key_ciphertext: string;
}
interface TaskRow extends RowDataPacket {
  id: string; user_id: string; local_task_id: string; idempotency_key: string; request_hash: string;
  task_type: string; logical_model_code: string; provider_id: string; provider_model_id: string;
  remote_task_id: string | null; status: string; progress: number | string; revision: number;
  estimated_credits: number | string; settled_credits: number | string; error_code: string | null;
  created_at: Date; updated_at: Date; finished_at: Date | null;
}
interface ResolutionPriceRow extends RowDataPacket { credit_cost: number | string; }

// Synchronous image models return base64 image bytes in their JSON response.
const responseLimit = 64 * 1024 * 1024;
const geminiVideoMimeTypes = new Set([
  "video/mp4", "video/mpeg", "video/mov", "video/avi", "video/x-flv",
  "video/mpg", "video/webm", "video/wmv", "video/3gpp",
]);
function transactionNumber(prefix: string): string { return `${prefix}${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 10)}`; }

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}
function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const source = value as Record<string, unknown>;
  for (const key of keys) { const candidate = source[key]; if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) return String(candidate); }
  for (const child of Object.values(source)) { const result = findString(child, keys, depth + 1); if (result) return result; }
  return null;
}
function upstreamStatus(value: unknown, fallback: string): string {
  const raw = (findString(value, ["status", "state", "task_status"]) || "").toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "FINISHED", "DONE", "1"].includes(raw)) return "SUCCEEDED";
  if (["FAIL", "FAILED", "ERROR", "REJECTED", "CANCELED", "CANCELLED", "2"].includes(raw)) return "FAILED";
  if (["RUNNING", "PROCESSING", "IN_PROGRESS", "GENERATING", "3"].includes(raw)) return "PROCESSING";
  if (["PENDING", "QUEUED", "SUBMITTED", "CREATED", "0", "4"].includes(raw)) return "PROVIDER_ACCEPTED";
  return fallback;
}
function applicationError(value: unknown): string | null {
  const source = asObject(value);
  if (source.success === false) return findString(value, ["error", "message", "msg"]) || "PROVIDER_REJECTED_REQUEST";
  if (typeof source.code === "number" && source.code !== 0 && source.code !== 200) return findString(value, ["error", "message", "msg"]) || `PROVIDER_CODE_${source.code}`;
  if (typeof source.code === "string" && source.code.trim() && !["0", "200", "OK", "SUCCESS"].includes(source.code.trim().toUpperCase())) return findString(value, ["error", "message", "msg"]) || `PROVIDER_CODE_${source.code}`;
  return null;
}
function validateGeminiVideoPayload(body: Record<string, unknown>): void {
  const contents = body.contents;
  if (!Array.isArray(contents) || !contents.length) throw new BadRequestException("GEM 视频理解请求必须包含 contents");
  const parts = asObject(contents[0]).parts;
  if (!Array.isArray(parts) || !parts.length) throw new BadRequestException("GEM 视频理解请求必须包含 contents[0].parts");
  const videoIndex = parts.findIndex((part) => {
    const source = asObject(part);
    return Boolean(source.file_data || source.inline_data);
  });
  if (videoIndex < 0) throw new BadRequestException("GEM 视频理解请求必须包含 file_data 或 inline_data 视频部分");
  const videoPart = asObject(parts[videoIndex]);
  const fileData = asObject(videoPart.file_data);
  const inlineData = asObject(videoPart.inline_data);
  const mimeType = String(fileData.mime_type || inlineData.mime_type || "");
  if (!geminiVideoMimeTypes.has(mimeType)) throw new BadRequestException("GEM 视频 MIME 类型不受支持");
  if (Object.keys(fileData).length) {
    const uri = String(fileData.file_uri || "");
    let parsed: URL;
    try { parsed = new URL(uri); } catch { throw new BadRequestException("GEM file_data.file_uri 格式无效"); }
    if (parsed.protocol !== "https:") throw new BadRequestException("GEM file_data.file_uri 必须使用 HTTPS");
  } else if (typeof inlineData.data !== "string" || !inlineData.data) {
    throw new BadRequestException("GEM inline_data.data 不能为空");
  }
  const textIndex = parts.findIndex((part) => typeof asObject(part).text === "string" && String(asObject(part).text).trim());
  if (textIndex < 0) throw new BadRequestException("GEM 视频理解请求必须包含文本提示");
  if (textIndex < videoIndex) throw new BadRequestException("Gemini 视频理解的文本提示应放在视频部分之后");
}
function joinUrl(baseUrl: string, endpoint: string): string {
  const result = /^https?:\/\//i.test(endpoint) ? endpoint : `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  let parsed: URL; try { parsed = new URL(result); } catch { throw new BadRequestException("模型接口地址无效"); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new BadRequestException("模型接口必须使用 HTTPS");
  return parsed.toString();
}
function parseResponse(text: string, contentType: string | null): unknown {
  if (text.length > responseLimit) return { truncated: true, raw: text.slice(0, responseLimit) };
  if (contentType?.includes("json") || /^[\s]*[\[{]/.test(text)) { try { return JSON.parse(text) as unknown; } catch { /* return raw */ } }
  return { content_type: contentType, raw: text };
}

@Injectable()
export class ModelGatewayService {
  private readonly logger = new Logger(ModelGatewayService.name);
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(ModelCreditMultiplierService) private readonly creditMultipliers: ModelCreditMultiplierService,
    @Inject(WagaModelMetadataService) private readonly wagaMetadata?: WagaModelMetadataService) {}

  private async target(modelId: string): Promise<TargetRow> {
    const rows = await this.database.query<TargetRow[]>(
      `SELECT p.id AS provider_id, p.code AS provider_code, p.base_url, p.config_json AS provider_config_json,
              pm.id AS model_id, pm.model_code, pm.model_alias, pm.capability, pm.api_protocol,
              pm.generation_endpoint, pm.query_endpoint, pm.credit_cost, pm.supports_async_tasks,
              pm.config_json AS model_config_json, pm.parameter_schema_json, pc.id AS credential_id, pc.api_key_ciphertext
       FROM provider_models pm INNER JOIN providers p ON p.id = pm.provider_id
       INNER JOIN provider_credentials pc ON pc.provider_id = p.id
       WHERE pm.id = ? AND pm.status = 'ACTIVE' AND p.status = 'ACTIVE'
         AND pc.status = 'ACTIVE' AND pc.api_key_ciphertext IS NOT NULL AND LENGTH(pc.api_key_ciphertext) > 0
         AND (pm.capability NOT IN ('IMAGE_GENERATION', 'VIDEO_GENERATION') OR EXISTS
              (SELECT 1 FROM ai_default_media_models dm WHERE dm.provider_model_id = pm.id AND dm.capability = pm.capability))
       ORDER BY pc.created_at, pc.id LIMIT 1`,
      [modelId],
    );
    if (!rows.length) throw new ServiceUnavailableException("模型、供应商或 API Key 未启用");
    const target = rows[0]!;
    if (target.provider_code === "wagaai" && this.wagaMetadata && wagaProfiles[target.model_code]) {
      target.parameter_schema_json = await this.wagaMetadata.schema(target.provider_id, target.model_code);
      const config = parseStoredJson<Record<string, unknown>>(target.model_config_json) || {};
      const prices = await this.database.query<RowDataPacket[]>("SELECT resolution, credit_cost FROM provider_model_resolution_prices WHERE provider_model_id = ?", [target.model_id]);
      const existingPlans = asObject(config.generation_parameters_by_resolution);
      if (prices.some(price => !Object.keys(existingPlans).some(key => key.toLowerCase() === String(price.resolution).toLowerCase()))) {
        const plans = await this.wagaMetadata.plans(target.provider_id, {
          id: target.model_id, model_code: target.model_code, model_alias: target.model_alias, capability: target.capability,
          api_protocol: target.api_protocol, credit_cost: Number(target.credit_cost), parameter_schema_json: target.parameter_schema_json,
          config_json: config, resolution_prices: prices.map(p => ({ resolution: String(p.resolution), credit_cost: Number(p.credit_cost) })),
        });
        target.model_config_json = { ...config, generation_parameters_by_resolution: { ...plans, ...existingPlans } };
      }
    }
    return target;
  }

  private async defaultVideoUnderstandingTarget(): Promise<TargetRow> {
    const rows = await this.database.query<TargetRow[]>(
      `SELECT p.id AS provider_id, p.code AS provider_code, p.base_url, p.config_json AS provider_config_json,
              pm.id AS model_id, pm.model_code, pm.model_alias, pm.capability, pm.api_protocol,
              pm.generation_endpoint, pm.query_endpoint, pm.credit_cost, pm.supports_async_tasks,
              pm.config_json AS model_config_json, pm.parameter_schema_json, pc.id AS credential_id, pc.api_key_ciphertext
       FROM ai_default_model_config dc
       INNER JOIN provider_models pm ON pm.id = dc.video_understanding_model_id
       INNER JOIN providers p ON p.id = pm.provider_id
       INNER JOIN provider_credentials pc ON pc.provider_id = p.id
       WHERE dc.id = 1 AND pm.capability = 'VIDEO_UNDERSTANDING'
         AND pm.status = 'ACTIVE' AND p.status = 'ACTIVE'
         AND pc.status = 'ACTIVE' AND pc.api_key_ciphertext IS NOT NULL AND LENGTH(pc.api_key_ciphertext) > 0
       ORDER BY pc.created_at, pc.id LIMIT 1`,
    );
    if (!rows.length) throw new ServiceUnavailableException("尚未配置可用的默认视频理解大模型");
    if (Number(rows[0]!.supports_async_tasks)) throw new ServiceUnavailableException("默认视频理解模型必须使用同步调用模式");
    return rows[0]!;
  }

  private async defaultTextTarget(): Promise<TargetRow> {
    const rows = await this.database.query<RowDataPacket[]>(
      "SELECT text_model_id FROM ai_default_model_config WHERE id = 1",
    );
    if (!rows[0]?.text_model_id) throw new ServiceUnavailableException("尚未配置默认文本大模型");
    const target = await this.target(String(rows[0].text_model_id));
    if (target.capability !== "TEXT_GENERATION") throw new ServiceUnavailableException("默认文本大模型类型不正确");
    if (Number(target.supports_async_tasks)) throw new ServiceUnavailableException("默认文本大模型必须使用同步调用模式");
    return target;
  }

  /** Read-only price preview. Uses exactly the same calculator as task reservation. */
  async quote(input: { providerModelId?: string; capability?: string; payload: unknown }): Promise<Record<string, unknown>> {
    const target = input.providerModelId ? await this.target(input.providerModelId)
      : input.capability === "TEXT_GENERATION" ? await this.defaultTextTarget()
      : input.capability === "VIDEO_UNDERSTANDING" ? await this.defaultVideoUnderstandingTarget()
      : undefined;
    if (!target) throw new BadRequestException("请选择大模型或指定文本/视频理解类型");
    const payload = asObject(input.payload);
    const credits = await this.estimatedCredits(target, payload);
    return {
      provider_model_id: target.model_id, model_alias: target.model_alias || target.model_code,
      model_code: target.model_code, capability: target.capability, credits,
      resolution: payload.resolution ?? asObject(payload.params).resolution ?? null,
      seconds: target.capability === "VIDEO_GENERATION" ? Number(payload.seconds ?? payload.duration ?? asObject(payload.params).seconds ?? asObject(payload.params).duration) : null,
      billing_unit: target.capability === "VIDEO_GENERATION" ? "PER_SECOND" : "PER_REQUEST",
      includes_multiplier: true,
    };
  }

  async createVideoUnderstanding(userId: string, input: { idempotencyKey: string; prompt: string; videoUrl: string; mimeType?: string; providerModelId?: string; expectedCredits?: number }): Promise<Record<string, unknown>> {
    const target = input.providerModelId ? await this.target(input.providerModelId) : await this.defaultVideoUnderstandingTarget();
    if (target.capability !== "VIDEO_UNDERSTANDING") throw new BadRequestException("请选择视频理解模型");
    return this.create(userId, {
      idempotencyKey: input.idempotencyKey,
      providerModelId: target.model_id,
      expectedCredits: input.expectedCredits,
      payload: {
        prompt: input.prompt,
        video_uri: input.videoUrl,
        reference_video: input.videoUrl,
        mime_type: input.mimeType || "video/mp4",
        generationConfig: { temperature: 0.2, maxOutputTokens: 16_384 },
      },
    });
  }

  async createVideoUnderstandingUpload(userId: string, input: {
    idempotencyKey: string;
    prompt: string;
    providerModelId?: string;
    expectedCredits?: number;
    file?: { buffer: Buffer; mimetype: string; originalname: string; size: number };
  }): Promise<Record<string, unknown>> {
    const file = input.file;
    if (!file || !file.buffer?.length) throw new BadRequestException("请上传压缩后的视频文件");
    if (!geminiVideoMimeTypes.has(file.mimetype)) throw new BadRequestException("上传的视频 MIME 类型不受支持");
    if (file.size > 15 * 1024 * 1024) throw new BadRequestException("压缩后的视频不能超过 15MB");
    const target = input.providerModelId ? await this.target(input.providerModelId) : await this.defaultVideoUnderstandingTarget();
    if (target.capability !== "VIDEO_UNDERSTANDING") throw new BadRequestException("请选择视频理解模型");
    return this.create(userId, {
      idempotencyKey: input.idempotencyKey,
      providerModelId: target.model_id,
      expectedCredits: input.expectedCredits,
      payload: {
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: file.mimetype, data: file.buffer.toString("base64") } },
          { text: input.prompt },
        ] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 16_384 },
      },
    });
  }

  private async estimatedCredits(target: TargetRow, payload: Record<string, unknown>): Promise<number> {
    if (wagaProfiles[target.model_code] && target.api_protocol?.toLowerCase() === "lingkeai_media") {
      wagaMediaParams(target.model_code, parseStoredJson(target.parameter_schema_json), parseStoredJson(target.model_config_json), payload);
    }
    let base = Number(target.credit_cost);
    if (["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(target.capability)) {
      const params = asObject(payload.params);
      const resolution = String(payload.resolution ?? params.resolution ?? "").trim();
      if (!resolution) throw new BadRequestException("图片或视频生成任务必须选择分辨率");
      if (!supportsMediaResolution({ resolution, schema: parseStoredJson(target.parameter_schema_json),
        config: parseStoredJson<Record<string, unknown>>(target.model_config_json) || {}, protocol: target.api_protocol || "",
        capability: target.capability, modelCode: target.model_code })) {
        throw new BadRequestException(`所选清晰度 ${resolution} 当前不可用，请重新选择。`);
      }
      const prices = await this.database.query<ResolutionPriceRow[]>(
        "SELECT credit_cost FROM provider_model_resolution_prices WHERE provider_model_id = ? AND LOWER(resolution) = LOWER(?) LIMIT 1",
        [target.model_id, resolution],
      );
      if (!prices.length) throw new BadRequestException("所选模型不支持该分辨率");
      base = Number(prices[0]!.credit_cost);
    }
    if (!Number.isFinite(base) || base < 0) throw new ServiceUnavailableException("模型积分价格配置无效");
    const { multipliers } = await this.creditMultipliers.get();
    // Persist only the final estimate on task creation. Settlement never reapplies a later multiplier.
    base = multiplyCredits(base, multiplierFor(multipliers, target.capability));
    if (target.capability !== "VIDEO_GENERATION") return base;
    const params = asObject(payload.params);
    const seconds = Number(payload.seconds ?? payload.duration ?? params.seconds ?? params.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new BadRequestException("视频生成任务必须提供有效的 seconds 或 duration");
    return multiplyCredits(base, seconds);
  }

  private request(target: TargetRow, payload: Record<string, unknown>, apiKey: string): { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | FormData } {
    const protocol = target.api_protocol.toLowerCase();
    const modelConfig = parseStoredJson<Record<string, unknown>>(target.model_config_json) || {};
    const providerConfig = parseStoredJson<Record<string, unknown>>(target.provider_config_json) || {};
    const source = { ...payload };
    const isMedia = ["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(target.capability);
    const selectedResolution = String(source.resolution ?? asObject(source.params).resolution ?? "").trim();
    if (isMedia && source.resolution != null && asObject(source.params).resolution != null && selectedResolution.toLowerCase() !== String(asObject(source.params).resolution).trim().toLowerCase()) {
      throw new BadRequestException("resolution 与 params.resolution 不一致");
    }
    const upstreamResolution = isMedia && !(protocol === "lingkeai_media" && wagaProfiles[target.model_code]?.resolution === false) ? resolveMediaResolution({
      resolution: selectedResolution,
      aspectRatio: String(source.aspect_ratio ?? asObject(source.params).aspect_ratio ?? "9:16"),
      schema: parseStoredJson(target.parameter_schema_json), config: modelConfig,
      protocol, capability: target.capability, modelCode: target.model_code,
    }) : undefined;
    delete source.model;
    delete source.model_id;
    let endpoint = target.generation_endpoint.replaceAll("{model}", encodeURIComponent(target.model_code)).replaceAll("{action}", String(modelConfig.test_action || "generateContent"));
    let body: Record<string, unknown> | FormData;
    if (protocol === "gemini") {
      const prompt = source.prompt;
      const referenceImages = Array.isArray(source.reference_images) ? source.reference_images : [];
      const aspectRatio = String(source.aspect_ratio || asObject(source.params).aspect_ratio || "");
      const resolution = String(source.resolution || asObject(source.params).resolution || "");
      const videoUri = source.video_uri || source.reference_video;
      const mimeType = String(source.mime_type || source.video_mime_type || "video/mp4");
      const mediaResolution = source.media_resolution;
      delete source.prompt;
      delete source.video_uri;
      delete source.reference_video;
      delete source.mime_type;
      delete source.video_mime_type;
      delete source.media_resolution;
      delete source.reference_images;
      delete source.aspect_ratio;
      delete source.resolution;
      delete source.params;
      if (target.capability === "TEXT_GENERATION" && Array.isArray(source.messages)) {
        if (source.tools) throw new BadRequestException("此文本模型协议尚不支持 Agent 工具调用，请配置 OpenAI 兼容文本模型；本次未扣分");
        const messages = source.messages.map(asObject);
        body = {
          contents: messages.filter(message => message.role !== "system").map(message => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }],
          })),
          systemInstruction: { parts: messages.filter(message => message.role === "system").map(message => ({ text: String(message.content || "") })) },
          generationConfig: { temperature: Number(source.temperature ?? 0.35) },
        };
      } else if (source.contents) body = source;
      else if (target.capability === "VIDEO_UNDERSTANDING" && typeof videoUri === "string" && videoUri.trim()) {
        let parsedVideoUrl: URL;
        try { parsedVideoUrl = new URL(videoUri); } catch { throw new BadRequestException("GEM 视频 URI / URL 格式无效"); }
        if (parsedVideoUrl.protocol !== "https:") throw new BadRequestException("GEM 视频 URI / URL 必须使用 HTTPS");
        body = {
          ...source,
          contents: [{ role: "user", parts: [
            { file_data: { file_uri: videoUri, mime_type: mimeType }, ...(typeof mediaResolution === "string" && mediaResolution ? { media_resolution: mediaResolution } : {}) },
            { text: typeof prompt === "string" ? prompt : "请分析视频画面、人物对话台词、关键事件与音频信息。" },
          ] }],
        };
      } else {
        const parts: Record<string, unknown>[] = [{ text: typeof prompt === "string" ? prompt : "" }];
        for (const item of referenceImages) {
          const reference = asObject(item);
          const dataUrl = String(reference.data_url || "");
          const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
        body = { ...source, contents: [{ role: "user", parts }], ...(target.capability === "IMAGE_GENERATION" ? { generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { ...(aspectRatio ? { aspectRatio } : {}), ...(resolution ? { imageSize: resolution } : {}) } } } : {}) };
      }
      if (target.capability === "VIDEO_UNDERSTANDING") validateGeminiVideoPayload(body);
    } else if (protocol === "lingkeai_media") {
      const prompt = source.prompt; const providedParams = { ...asObject(source.params) }; delete source.prompt; delete source.params;
      const references = (Array.isArray(source.reference_images) ? source.reference_images : Array.isArray(providedParams.reference_images) ? providedParams.reference_images : []).map((item) => {
        const reference = asObject(item);
        return { url: typeof item === "string" ? item : String(reference.data_url || reference.url || ""), label: String(reference.label || "参考图"), type: String(reference.type || "reference") };
      }).filter((reference) => reference.url).sort((a, b) => Number(b.type === "shot_first_frame") - Number(a.type === "shot_first_frame"));
      delete source.reference_images; delete providedParams.reference_images;
      let params = { ...source, ...providedParams };
      delete params.seconds;
      if (wagaProfiles[target.model_code]) {
        params = wagaMediaParams(target.model_code, parseStoredJson(target.parameter_schema_json), modelConfig, payload, { submit: true, references });
      } else if (target.capability === "VIDEO_GENERATION") {
        params.images = references.map((reference) => reference.url);
        if (target.model_code === "kwvideo-v2-ref" && !params.version) params.version = "标准";
        if (target.model_code === "omni_flash-10s") { delete params.resolution; delete params.duration; delete params.version; }
      } else params.reference_images = references;
      const guide = references.length ? `\n\n参考图对应关系：\n${references.map((reference, index) => `第${index + 1}张：${reference.label}`).join("\n")}` : "";
      body = { model: target.model_code, prompt: `${typeof prompt === "string" ? prompt : ""}${guide}`, params,
        ...(target.capability === "IMAGE_GENERATION" && !wagaProfiles[target.model_code] ? { images: references } : {}) };
    } else if (protocol === "allaiin_rest") {
      body = { ...source };
      const id = Number(modelConfig.remote_numeric_id);
      if (Number.isInteger(id) && id > 0) body.model_id = id;
      else body.model = target.model_code;
    } else if (target.capability === "IMAGE_GENERATION") {
      const references = Array.isArray(source.reference_images) ? source.reference_images : [];
      const aspectRatio = String(source.aspect_ratio || asObject(source.params).aspect_ratio || "9:16");
      const configuredResolution = String(source.resolution || asObject(source.params).resolution || "");
      const size = /^\d+x\d+$/i.test(configuredResolution) ? configuredResolution : aspectRatio === "16:9" ? "1536x1024" : "1024x1536";
      const prompt = String(source.prompt || "");
      if (references.length) {
        if (endpoint.includes("/generations")) endpoint = endpoint.replace("/generations", "/edits");
        const form = new FormData();
        form.set("model", target.model_code); form.set("prompt", prompt); form.set("size", size);
        for (const [index, item] of references.entries()) {
          const reference = asObject(item); const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(reference.data_url || ""));
          if (!match) continue;
          const bytes = Buffer.from(match[2]!, "base64");
          form.append("image[]", new Blob([bytes], { type: match[1] }), `reference-${index + 1}`);
        }
        body = form;
      } else body = { model: target.model_code, prompt, size };
    } else {
      body = { ...source, model: target.model_code };
      if (!["IMAGE_GENERATION", "VIDEO_GENERATION"].includes(target.capability) && !body.messages && typeof body.prompt === "string") { body.messages = [{ role: "user", content: body.prompt }]; delete body.prompt; }
    }
    if (isMedia) {
      const setResolution = (destination: Record<string, unknown>) => {
        delete destination.resolution; delete destination.imageSize; delete destination.image_size;
        if (target.capability === "IMAGE_GENERATION") delete destination.size;
        if (upstreamResolution) destination[upstreamResolution.field] = upstreamResolution.value;
      };
      if (body instanceof FormData) {
        for (const field of ["resolution", "imageSize", "image_size", "size"]) body.delete(field);
        if (upstreamResolution) body.set(upstreamResolution.field, upstreamResolution.value);
      } else if (protocol === "gemini") {
        if (target.capability === "IMAGE_GENERATION") {
          const generationConfig = asObject(body.generationConfig);
          body.generationConfig = { ...generationConfig, imageConfig: { ...asObject(generationConfig.imageConfig), ...(upstreamResolution ? { imageSize: upstreamResolution.value } : {}) } };
        } else {
          body.parameters = { ...asObject(body.parameters), ...(upstreamResolution ? { resolution: upstreamResolution.value } : {}) };
        }
      } else if (protocol === "lingkeai_media") {
        const params = { ...asObject(body.params) }; setResolution(params); body.params = params;
      } else {
        setResolution(body);
        // Keep duplicated compatibility parameters identical: nested params must
        // never override the selected resolution with a different tier or casing.
        if (body.params) { const params = { ...asObject(body.params) }; setResolution(params); body.params = params; }
      }
    }
    const authHeader = String(modelConfig.auth_header || providerConfig.auth_header || "Authorization");
    const scheme = String(modelConfig.auth_scheme ?? providerConfig.auth_scheme ?? "Bearer").trim();
    return { url: joinUrl(target.base_url, endpoint), method: String(modelConfig.test_generation_method || "POST").toUpperCase(), headers: { ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), [authHeader]: scheme ? `${scheme} ${apiKey}` : apiKey }, body };
  }

  private queryRequest(target: TargetRow, taskId: string, apiKey: string): { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> } {
    if (!target.query_endpoint) throw new BadRequestException("该模型未配置查询接口");
    const modelConfig = parseStoredJson<Record<string, unknown>>(target.model_config_json) || {};
    const providerConfig = parseStoredJson<Record<string, unknown>>(target.provider_config_json) || {};
    const method = String(modelConfig.test_query_method || "GET").toUpperCase(); const parameter = String(modelConfig.test_query_task_parameter || "task_id");
    const hasPlaceholder = target.query_endpoint.includes("{task_id}");
    const endpoint = target.query_endpoint.replaceAll("{task_id}", encodeURIComponent(taskId)); let url = joinUrl(target.base_url, endpoint); let body: Record<string, unknown> | undefined;
    if (!hasPlaceholder && method === "GET") { const parsed = new URL(url); parsed.searchParams.set(parameter, taskId); url = parsed.toString(); }
    else if (!hasPlaceholder) body = { [parameter]: taskId };
    const authHeader = String(modelConfig.auth_header || providerConfig.auth_header || "Authorization"); const scheme = String(modelConfig.auth_scheme ?? providerConfig.auth_scheme ?? "Bearer").trim();
    return { url, method, headers: { "Content-Type": "application/json", [authHeader]: scheme ? `${scheme} ${apiKey}` : apiKey }, body };
  }

  private async call(request: { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> | FormData }): Promise<{ ok: boolean; status: number; value: unknown }> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      const body = request.body instanceof FormData ? request.body : JSON.stringify(request.body || {});
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : body, signal: controller.signal });
      const text = await response.text(); return { ok: response.ok, status: response.status, value: parseResponse(text, response.headers.get("content-type")) };
    } catch (error) { throw new BadGatewayException(error instanceof Error ? error.message : "供应商请求失败"); }
    finally { clearTimeout(timeout); }
  }

  private taskView(row: TaskRow): Record<string, unknown> {
    return { ...row, progress: Number(row.progress), estimated_credits: Number(row.estimated_credits), settled_credits: Number(row.settled_credits) };
  }

  private async existing(userId: string, idempotencyKey: string, requestHash: string): Promise<Record<string, unknown> | null> {
    const rows = await this.database.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1", [userId, idempotencyKey]);
    if (!rows.length) return null;
    if (rows[0]!.request_hash !== requestHash) throw new ConflictException("相同幂等键对应了不同请求");
    return { task: this.taskView(rows[0]!), idempotent_replay: true };
  }

  private async release(taskId: string, status: "FAILED" | "CANCELED", errorCode: string): Promise<void> {
    await this.database.transaction(async (connection) => {
      await connection.execute("UPDATE credit_holds SET status = 'RELEASED' WHERE task_id = ? AND status = 'ACTIVE'", [taskId]);
      await connection.execute("UPDATE ai_tasks SET status = ?, error_code = ?, revision = revision + 1, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [status, errorCode.slice(0, 100), taskId]);
      await connection.execute("UPDATE task_attempts SET status = ?, error_code = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE task_id = ? AND finished_at IS NULL", [status, errorCode.slice(0, 100), taskId]);
    });
  }

  private async settle(taskId: string, upstreamUsage?: unknown): Promise<void> {
    await this.database.transaction(async (connection) => {
      const [tasks] = await connection.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE id = ? LIMIT 1 FOR UPDATE", [taskId]); const task = tasks[0];
      if (!task) return;
      const [holds] = await connection.query<RowDataPacket[]>("SELECT status FROM credit_holds WHERE task_id = ? LIMIT 1 FOR UPDATE", [taskId]);
      if (!holds.length || holds[0]!.status !== "ACTIVE") return;
      const amount = Number(task.estimated_credits);
      const [accounts] = await connection.query<RowDataPacket[]>("SELECT id FROM ledger_accounts WHERE owner_type = 'USER' AND owner_id = ? AND account_type = 'AVAILABLE' AND currency = 'CREDIT' LIMIT 1 FOR UPDATE", [task.user_id]);
      if (!accounts.length) throw new NotFoundException("用户积分账户不存在");
      const transactionId = randomUUID();
      await connection.execute("INSERT INTO ledger_transactions (id, transaction_type, reference_type, reference_id, metadata_json) VALUES (?, 'MODEL_CONSUMPTION', 'ai_task', ?, ?)", [transactionId, taskId, upstreamUsage === undefined ? null : JSON.stringify(upstreamUsage)]);
      await connection.execute("INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES (?, ?, ?, ?)", [randomUUID(), transactionId, accounts[0]!.id, -amount]);
      await connection.execute("UPDATE credit_holds SET status = 'CAPTURED' WHERE task_id = ? AND status = 'ACTIVE'", [taskId]);
      await connection.execute("UPDATE ai_tasks SET status = 'SUCCEEDED', progress = 1, settled_credits = ?, usage_json = ?, revision = revision + 1, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [amount, upstreamUsage === undefined ? null : JSON.stringify(upstreamUsage), taskId]);
      await connection.execute("UPDATE task_attempts SET status = 'SUCCEEDED', usage_json = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE task_id = ? AND finished_at IS NULL", [upstreamUsage === undefined ? null : JSON.stringify(upstreamUsage), taskId]);
      await connection.execute(
        `INSERT INTO credit_consumption_records
          (id, consumption_no, user_id, task_id, provider_model_id, category, credits_consumed, status, description, occurred_at)
         VALUES (?, ?, ?, ?, ?, 'MODEL_TASK', ?, 'CONFIRMED', ?, CURRENT_TIMESTAMP(3))`,
        [randomUUID(), transactionNumber("CC"), task.user_id, taskId, task.provider_model_id, amount, `${task.logical_model_code} 模型任务`],
      );
    });
  }

  async create(userId: string, input: { localTaskId?: string; idempotencyKey: string; providerModelId: string; payload: unknown; expectedCredits?: number }): Promise<Record<string, unknown>> {
    const payload = asObject(input.payload); if (!Object.keys(payload).length) throw new BadRequestException("payload 必须是非空 JSON 对象");
    const localTaskId = input.localTaskId || randomUUID(); if (!/^[0-9a-f-]{36}$/i.test(localTaskId)) throw new BadRequestException("local_task_id 必须是 UUID");
    const requestHash = createHash("sha256").update(JSON.stringify(canonical({ model: input.providerModelId, payload }))).digest("hex");
    const replay = await this.existing(userId, input.idempotencyKey, requestHash); if (replay) return replay;
    let target: TargetRow;
    let credits: number;
    let providerRequest: ReturnType<ModelGatewayService["request"]>;
    try {
    target = await this.target(input.providerModelId); credits = await this.estimatedCredits(target, payload);
    if (input.expectedCredits !== undefined && (!Number.isFinite(input.expectedCredits) || input.expectedCredits < 0 || input.expectedCredits !== credits)) {
      throw new ConflictException("本次需要的积分有变化，请重新确认后再开始。现在没有扣分。");
    }
    providerRequest = this.request(target, payload, this.secretCrypto.decrypt(target.api_key_ciphertext));
    } catch (error) {
      // These validation failures occur before any hold, task, or upstream call.
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException) {
        throw new BadRequestException({ code: "TASK_NOT_SUBMITTED", retryable: false,
          message: `${error.message} 本次没有开始生成，没有扣分。` });
      }
      throw error;
    }
    const taskId = randomUUID(); const attemptId = randomUUID();
    for (let reservationAttempt = 0; ; reservationAttempt++) {
      try {
        await this.database.transaction(async (connection) => {
        // Serialize this user's reservations before inspecting missing task keys.
        // Locking a missing ai_tasks key first can deadlock concurrent images
        // against the wallet lock and each other's insertion gap locks.
        const [accounts] = await connection.query<RowDataPacket[]>("SELECT id FROM ledger_accounts WHERE owner_type = 'USER' AND owner_id = ? AND account_type = 'AVAILABLE' AND currency = 'CREDIT' LIMIT 1 FOR UPDATE", [userId]);
        if (!accounts.length) throw new NotFoundException("用户积分账户不存在");
        const [existingRows] = await connection.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1", [userId, input.idempotencyKey]);
        if (existingRows.length) { if (existingRows[0]!.request_hash !== requestHash) throw new ConflictException("相同幂等键对应了不同请求"); throw new ConflictException("任务正在由相同幂等请求创建"); }
        const [balanceRows] = await connection.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) balance FROM ledger_entries WHERE account_id = ?", [accounts[0]!.id]);
        const [holdRows] = await connection.query<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) held FROM credit_holds WHERE user_id = ? AND status = 'ACTIVE'", [userId]);
        if (Number(balanceRows[0]?.balance || 0) - Number(holdRows[0]?.held || 0) < credits) throw new ConflictException("可用积分不足");
        await connection.execute(
          `INSERT INTO ai_tasks
            (id, user_id, local_task_id, idempotency_key, request_hash, task_type, logical_model_code,
             provider_id, provider_model_id, status, estimated_credits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREDIT_RESERVED', ?)`,
          [taskId, userId, localTaskId, input.idempotencyKey, requestHash, target.capability, target.model_code, target.provider_id, target.model_id, credits],
        );
        await connection.execute("INSERT INTO credit_holds (id, user_id, task_id, amount, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 MINUTE))", [randomUUID(), userId, taskId, credits]);
        await connection.execute("INSERT INTO task_attempts (id, task_id, attempt_number, provider_id, provider_model_id, status) VALUES (?, ?, 1, ?, ?, 'SUBMITTING')", [attemptId, taskId, target.provider_id, target.model_id]);
        });
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        this.logger.warn({ event: "task.reservation_failed", localTaskId, code: code || "RESERVATION_REJECTED", attempt: reservationAttempt + 1 });
        const found = await this.existing(userId, input.idempotencyKey, requestHash);
        if (found) return found;
        // DatabaseService.transaction has rolled back before throwing. Do not
        // retry connection/commit ambiguity or any provider call here.
        if (code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT") {
          if (reservationAttempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 50 * (reservationAttempt + 1)));
            continue;
          }
          throw new ServiceUnavailableException({ code: "TASK_NOT_SUBMITTED", retryable: true,
            message: "服务暂时繁忙，本次没有开始生成，也没有扣分，可以重试。" });
        }
        throw error;
      }
    }
    try {
      const result = await this.call(providerRequest);
      if (!result.ok) throw new BadGatewayException(`供应商创建任务返回 HTTP ${result.status}`);
      const upstreamError = applicationError(result.value);
      if (upstreamError) throw new BadGatewayException(`供应商创建任务失败：${upstreamError}`);
      const remoteTaskId = findString(result.value, ["task_id", "taskId", "id", "request_id", "prediction_id"]);
      let status = Number(target.supports_async_tasks) ? upstreamStatus(result.value, "PROVIDER_ACCEPTED") : "SUCCEEDED";
      if (Number(target.supports_async_tasks) && !remoteTaskId && status !== "SUCCEEDED") throw new BadGatewayException("供应商响应中缺少任务 ID");
      await this.database.transaction(async (connection) => {
        await connection.execute("UPDATE ai_tasks SET remote_task_id = ?, status = ?, revision = revision + 1 WHERE id = ?", [remoteTaskId, status, taskId]);
        await connection.execute("UPDATE task_attempts SET remote_task_id = ?, status = ? WHERE id = ?", [remoteTaskId, status, attemptId]);
      });
      if (status === "SUCCEEDED") await this.settle(taskId, asObject(result.value).usage);
      else if (status === "FAILED") await this.release(taskId, "FAILED", findString(result.value, ["error", "message", "msg"]) || "PROVIDER_TASK_FAILED");
      const rows = await this.database.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE id = ? LIMIT 1", [taskId]);
      return { task: this.taskView(rows[0]!), provider_response: result.value };
    } catch (error) { await this.release(taskId, "FAILED", error instanceof Error ? error.message : "PROVIDER_CREATE_FAILED"); throw error; }
  }

  async get(userId: string, taskId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.query<TaskRow[]>("SELECT t.*, EXISTS(SELECT 1 FROM credit_holds h WHERE h.task_id=t.id AND h.status='RELEASED') AS credits_released FROM ai_tasks t WHERE t.id = ? AND t.user_id = ? LIMIT 1", [taskId, userId]);
    if (!rows.length) throw new NotFoundException("任务不存在");
    return { ...this.taskView(rows[0]!), credits_released: Number(rows[0]!.credits_released) === 1 };
  }

  async getByLocal(userId: string, localId: string): Promise<Record<string, unknown>> {
    const rows = await this.database.query<TaskRow[]>("SELECT t.*, EXISTS(SELECT 1 FROM credit_holds h WHERE h.task_id=t.id AND h.status='RELEASED') AS credits_released FROM ai_tasks t WHERE t.local_task_id = ? AND t.user_id = ? LIMIT 1", [localId, userId]);
    if (!rows.length) throw new NotFoundException("任务不存在");
    return { ...this.taskView(rows[0]!), credits_released: Number(rows[0]!.credits_released) === 1 };
  }

  async list(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [userId]); return rows.map((row) => this.taskView(row));
  }

  async query(userId: string, taskId: string): Promise<Record<string, unknown>> {
    const taskRows = await this.database.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE id = ? AND user_id = ? LIMIT 1", [taskId, userId]); const task = taskRows[0];
    if (!task) throw new NotFoundException("任务不存在");
    if (task.status === "SUCCEEDED" && task.remote_task_id) {
      const target = await this.target(task.provider_model_id);
      if (target.query_endpoint) {
        const result = await this.call(this.queryRequest(target, task.remote_task_id, this.secretCrypto.decrypt(target.api_key_ciphertext)));
        if (!result.ok) throw new BadGatewayException(`供应商查询结果返回 HTTP ${result.status}`);
        return { task: this.taskView(task), terminal: true, provider_response: result.value };
      }
    }
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(task.status)) return { task: this.taskView(task), terminal: true };
    if (!task.remote_task_id) throw new ConflictException("任务尚未获得供应商任务 ID");
    const target = await this.target(task.provider_model_id);
    try {
      const result = await this.call(this.queryRequest(target, task.remote_task_id, this.secretCrypto.decrypt(target.api_key_ciphertext)));
      if (!result.ok) throw new BadGatewayException(`供应商查询任务返回 HTTP ${result.status}`);
      const upstreamError = applicationError(result.value);
      if (upstreamError) throw new BadGatewayException(`供应商查询任务失败：${upstreamError}`);
      const status = target.provider_code === "wagaai" && target.api_protocol === "lingkeai_media"
        ? wagaTaskStatus(result.value) : upstreamStatus(result.value, "PROCESSING");
      if (status === "SUCCEEDED") await this.settle(task.id, asObject(result.value).usage);
      else if (status === "FAILED") await this.release(task.id, "FAILED", findString(result.value, ["error", "message", "msg"]) || "PROVIDER_TASK_FAILED");
      else await this.database.execute("UPDATE ai_tasks SET status = ?, revision = revision + 1 WHERE id = ?", [status, task.id]);
      const rows = await this.database.query<TaskRow[]>("SELECT * FROM ai_tasks WHERE id = ? LIMIT 1", [task.id]);
      return { task: this.taskView(rows[0]!), provider_response: result.value };
    } catch (error) { throw error; }
  }
}
