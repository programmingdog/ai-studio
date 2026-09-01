import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { parseStoredJson } from "../common/input";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { DatabaseService } from "../database/database.service";

interface TestTargetRow extends RowDataPacket {
  provider_id: string;
  provider_code: string;
  provider_name: string;
  base_url: string;
  provider_config_json: unknown;
  model_id: string;
  model_code: string;
  model_alias: string;
  capability: string;
  api_protocol: string;
  generation_endpoint: string;
  query_endpoint: string | null;
  supports_async_tasks: number;
  model_config_json: unknown;
}

interface CredentialRow extends RowDataPacket {
  id: string;
  api_key_ciphertext: string | null;
}

interface TestRecordRow extends RowDataPacket {
  id: string;
  admin_user_id: string | null;
  provider_id: string;
  provider_model_id: string;
  provider_credential_id: string;
  provider_code: string;
  provider_name: string;
  model_code: string;
  model_alias: string;
  capability: string;
  credential_name: string;
  credential_hint: string;
  query_endpoint: string | null;
  status: string;
  request_json: unknown;
  create_url: string;
  create_http_status: number | null;
  create_duration_ms: number | null;
  create_response_json: unknown;
  remote_task_id: string | null;
  query_url: string | null;
  query_http_status: number | null;
  query_duration_ms: number | null;
  query_response_json: unknown;
  error_message: string | null;
  last_queried_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const responseLimit = 1_000_000;
const requestLimit = 256_000;
const secretKeyPattern = /api.?key|authorization|password|secret|token/i;
const geminiVideoMimeTypes = new Set([
  "video/mp4", "video/mpeg", "video/mov", "video/avi", "video/x-flv",
  "video/mpg", "video/webm", "video/wmv", "video/3gpp",
]);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    secretKeyPattern.test(key) ? "[REDACTED]" : redactSecrets(item),
  ]));
}

function parseResponse(text: string, contentType: string | null): unknown {
  if (text.length > responseLimit) {
    return { truncated: true, content_type: contentType, raw: text.slice(0, responseLimit) };
  }
  if (contentType?.includes("json") || /^[\s]*[\[{]/.test(text)) {
    try { return JSON.parse(text) as unknown; } catch { /* preserve non-JSON response below */ }
  }
  return { content_type: contentType, raw: text };
}

function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const source = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = source[key];
    if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) return String(candidate);
  }
  for (const child of Object.values(source)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function remoteStatus(value: unknown, fallback: string): string {
  const raw = (findString(value, ["status", "state", "task_status"]) || "").toUpperCase();
  if (raw === "1") return "SUCCEEDED";
  if (raw === "2") return "FAILED";
  if (raw === "3") return "PROCESSING";
  if (raw === "0" || raw === "4") return "SUBMITTED";
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "FINISHED", "DONE"].includes(raw)) return "SUCCEEDED";
  if (["FAIL", "FAILED", "ERROR", "REJECTED", "CANCELED", "CANCELLED"].includes(raw)) return "FAILED";
  if (["PENDING", "QUEUED", "SUBMITTED", "CREATED"].includes(raw)) return "SUBMITTED";
  if (["RUNNING", "PROCESSING", "IN_PROGRESS", "GENERATING"].includes(raw)) return "PROCESSING";
  return fallback;
}

function applicationError(value: unknown): string | null {
  const source = asObject(value);
  const code = source.code;
  if (typeof code === "number" && code !== 0 && code !== 200) {
    return String(source.message || source.msg || source.error || `上游业务状态码 ${code}`);
  }
  if (source.success === false) return String(source.message || source.msg || source.error || "上游业务请求失败");
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
  if (textIndex < videoIndex) throw new BadRequestException("按照 Gemini 视频理解最佳实践，文本提示应放在视频部分之后");
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const result = /^https?:\/\//i.test(endpoint)
    ? endpoint
    : `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new BadRequestException("模型测试接口地址无效"); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new BadRequestException("模型测试只允许 HTTPS 或本机接口");
  }
  return parsed.toString();
}

function pageSize(value?: string): number {
  const parsed = Number(value || 50);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
}

@Injectable()
export class ModelTestService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SecretCryptoService) private readonly secretCrypto: SecretCryptoService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(limit?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.query<TestRecordRow[]>(
      `SELECT tr.id, tr.admin_user_id, tr.provider_id, tr.provider_model_id, tr.provider_credential_id,
              p.code AS provider_code, p.display_name AS provider_name,
              pm.model_code, pm.model_alias, pm.capability, pm.query_endpoint,
              pc.name AS credential_name, pc.masked_hint AS credential_hint,
              tr.status, tr.request_json, tr.create_url, tr.create_http_status, tr.create_duration_ms,
              tr.create_response_json, tr.remote_task_id, tr.query_url, tr.query_http_status,
              tr.query_duration_ms, tr.query_response_json, tr.error_message,
              tr.last_queried_at, tr.created_at, tr.updated_at
       FROM model_test_records tr
       INNER JOIN providers p ON p.id = tr.provider_id
       INNER JOIN provider_models pm ON pm.id = tr.provider_model_id
       INNER JOIN provider_credentials pc ON pc.id = tr.provider_credential_id
       ORDER BY tr.created_at DESC LIMIT ${pageSize(limit)}`,
    );
    return rows.map((row) => ({
      ...row,
      request_json: parseStoredJson(row.request_json),
      create_response_json: row.create_response_json === null ? null : parseStoredJson(row.create_response_json),
      query_response_json: row.query_response_json === null ? null : parseStoredJson(row.query_response_json),
    }));
  }

  async create(
    adminUserId: string,
    providerId: string,
    modelId: string,
    input: { credentialId?: string; payload: unknown },
  ): Promise<Record<string, unknown>> {
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new BadRequestException("测试请求参数必须是 JSON 对象");
    }
    if (JSON.stringify(input.payload).length > requestLimit) throw new BadRequestException("测试请求参数不能超过 256 KB");
    const target = await this.getTarget(providerId, modelId);
    const credential = await this.getCredential(providerId, input.credentialId);
    const apiKey = this.secretCrypto.decrypt(credential.api_key_ciphertext!);
    const config = asObject(parseStoredJson(target.model_config_json));
    const providerConfig = asObject(parseStoredJson(target.provider_config_json));
    const requestModel = String(config.request_model_name || config.remote_model_id || target.model_code);
    const request = this.createRequest(target, requestModel, input.payload, config, providerConfig, apiKey);
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO model_test_records
        (id, admin_user_id, provider_id, provider_model_id, provider_credential_id,
         status, request_json, create_url)
       VALUES (?, ?, ?, ?, ?, 'CREATING', ?, ?)`,
      [id, adminUserId, providerId, modelId, credential.id, JSON.stringify(redactSecrets(request.body)), request.url],
    );

    const startedAt = Date.now();
    try {
      const response = await this.fetchUpstream(request.url, request.method, request.headers, request.body);
      const duration = Date.now() - startedAt;
      const responseValue = redactSecrets(parseResponse(response.text, response.contentType));
      const taskId = target.supports_async_tasks ? findString(responseValue, ["task_id", "taskId", "id"]) : null;
      const upstreamError = response.ok ? applicationError(responseValue) : null;
      const succeeded = response.ok && !upstreamError;
      const status = succeeded
        ? remoteStatus(responseValue, target.supports_async_tasks && taskId ? "SUBMITTED" : "SUCCEEDED")
        : "FAILED";
      const errorMessage = upstreamError || (response.ok ? null : `上游创建接口返回 HTTP ${response.status}`);
      await this.database.execute(
        `UPDATE model_test_records SET status = ?, create_http_status = ?, create_duration_ms = ?,
           create_response_json = ?, remote_task_id = ?, error_message = ? WHERE id = ?`,
        [status, response.status, duration, JSON.stringify(responseValue), taskId, errorMessage, id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.execute(
        `UPDATE model_test_records SET status = 'FAILED', create_duration_ms = ?, error_message = ? WHERE id = ?`,
        [Date.now() - startedAt, message.slice(0, 2000), id],
      );
    }
    await this.audit.record({ adminUserId, action: "provider_model.test.create", entityType: "model_test_record", entityId: id, details: { providerId, modelId } });
    return this.getById(id);
  }

  async query(adminUserId: string, testId: string): Promise<Record<string, unknown>> {
    const record = await this.getRecord(testId);
    if (!record.remote_task_id) throw new BadRequestException("测试记录没有可查询的远程任务 ID");
    const target = await this.getTarget(record.provider_id, record.provider_model_id);
    if (!target.query_endpoint) throw new BadRequestException("该模型没有配置查询接口");
    const credential = await this.getCredential(record.provider_id, record.provider_credential_id);
    const apiKey = this.secretCrypto.decrypt(credential.api_key_ciphertext!);
    const config = asObject(parseStoredJson(target.model_config_json));
    const providerConfig = asObject(parseStoredJson(target.provider_config_json));
    const request = this.queryRequest(target, record.remote_task_id, config, providerConfig, apiKey);
    const startedAt = Date.now();
    try {
      const response = await this.fetchUpstream(request.url, request.method, request.headers, request.body);
      const duration = Date.now() - startedAt;
      const responseValue = redactSecrets(parseResponse(response.text, response.contentType));
      const upstreamError = response.ok ? applicationError(responseValue) : null;
      const status = response.ok && !upstreamError ? remoteStatus(responseValue, "PROCESSING") : "QUERY_FAILED";
      const errorMessage = upstreamError || (response.ok ? null : `上游查询接口返回 HTTP ${response.status}`);
      await this.database.execute(
        `UPDATE model_test_records SET status = ?, query_url = ?, query_http_status = ?,
           query_duration_ms = ?, query_response_json = ?, error_message = ?,
           last_queried_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [status, request.url, response.status, duration, JSON.stringify(responseValue), errorMessage, testId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.execute(
        `UPDATE model_test_records SET status = 'QUERY_FAILED', query_url = ?, query_duration_ms = ?,
           error_message = ?, last_queried_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [request.url, Date.now() - startedAt, message.slice(0, 2000), testId],
      );
    }
    await this.audit.record({ adminUserId, action: "provider_model.test.query", entityType: "model_test_record", entityId: testId, details: { remoteTaskId: record.remote_task_id } });
    return this.getById(testId);
  }

  private async getTarget(providerId: string, modelId: string): Promise<TestTargetRow> {
    const rows = await this.database.query<TestTargetRow[]>(
      `SELECT p.id AS provider_id, p.code AS provider_code, p.display_name AS provider_name,
              p.base_url, p.config_json AS provider_config_json,
              pm.id AS model_id, pm.model_code, pm.model_alias, pm.capability, pm.api_protocol,
              pm.generation_endpoint, pm.query_endpoint, pm.supports_async_tasks,
              pm.config_json AS model_config_json
       FROM providers p INNER JOIN provider_models pm ON pm.provider_id = p.id
       WHERE p.id = ? AND pm.id = ? LIMIT 1`,
      [providerId, modelId],
    );
    if (!rows[0]) throw new NotFoundException("供应商模型不存在");
    return rows[0];
  }

  private async getCredential(providerId: string, credentialId?: string): Promise<CredentialRow> {
    const parameters: unknown[] = [providerId];
    let credentialFilter = "";
    if (credentialId) { credentialFilter = "AND id = ?"; parameters.push(credentialId); }
    const rows = await this.database.query<CredentialRow[]>(
      `SELECT id, api_key_ciphertext FROM provider_credentials
       WHERE provider_id = ? ${credentialFilter} AND status = 'ACTIVE' AND api_key_ciphertext IS NOT NULL
       ORDER BY created_at LIMIT 1`,
      parameters,
    );
    if (!rows[0]) throw new BadRequestException("该供应商没有可用的启用 API Key");
    return rows[0];
  }

  private async getRecord(testId: string): Promise<TestRecordRow> {
    const rows = await this.database.query<TestRecordRow[]>(
      `SELECT tr.*, p.code AS provider_code, p.display_name AS provider_name,
              pm.model_code, pm.model_alias, pm.capability, pm.query_endpoint,
              pc.name AS credential_name, pc.masked_hint AS credential_hint
       FROM model_test_records tr
       INNER JOIN providers p ON p.id = tr.provider_id
       INNER JOIN provider_models pm ON pm.id = tr.provider_model_id
       INNER JOIN provider_credentials pc ON pc.id = tr.provider_credential_id
       WHERE tr.id = ? LIMIT 1`,
      [testId],
    );
    if (!rows[0]) throw new NotFoundException("测试记录不存在");
    return rows[0];
  }

  private async getById(testId: string): Promise<Record<string, unknown>> {
    const row = await this.getRecord(testId);
    return {
      ...row,
      request_json: parseStoredJson(row.request_json),
      create_response_json: row.create_response_json === null ? null : parseStoredJson(row.create_response_json),
      query_response_json: row.query_response_json === null ? null : parseStoredJson(row.query_response_json),
    };
  }

  private authHeaders(providerConfig: Record<string, unknown>, modelConfig: Record<string, unknown>, apiKey: string): Record<string, string> {
    const header = String(modelConfig.auth_header || providerConfig.auth_header || "Authorization");
    const scheme = String(modelConfig.auth_scheme ?? providerConfig.auth_scheme ?? "Bearer").trim();
    return { "Content-Type": "application/json", [header]: scheme ? `${scheme} ${apiKey}` : apiKey };
  }

  private createRequest(
    target: TestTargetRow,
    requestModel: string,
    payload: unknown,
    modelConfig: Record<string, unknown>,
    providerConfig: Record<string, unknown>,
    apiKey: string,
  ): { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const protocol = target.api_protocol.toLowerCase();
    const source = { ...(payload as Record<string, unknown>) };
    let endpoint = target.generation_endpoint.replaceAll("{model}", encodeURIComponent(requestModel));
    endpoint = endpoint.replaceAll("{action}", String(modelConfig.test_action || "generateContent"));
    let body: Record<string, unknown>;
    if (protocol === "gemini") {
      const prompt = source.prompt;
      const videoUri = source.video_uri || source.reference_video;
      const mimeType = String(source.mime_type || source.video_mime_type || "video/mp4");
      const mediaResolution = source.media_resolution;
      delete source.prompt;
      delete source.video_uri;
      delete source.reference_video;
      delete source.mime_type;
      delete source.video_mime_type;
      delete source.media_resolution;
      if (source.contents) {
        body = source;
      } else if (target.capability === "VIDEO_UNDERSTANDING" && typeof videoUri === "string" && videoUri.trim()) {
        if (!geminiVideoMimeTypes.has(mimeType)) throw new BadRequestException("GEM 视频 MIME 类型不受支持");
        let parsedVideoUrl: URL;
        try { parsedVideoUrl = new URL(videoUri); } catch { throw new BadRequestException("GEM 视频 URI / URL 格式无效"); }
        if (parsedVideoUrl.protocol !== "https:") throw new BadRequestException("GEM 视频 URI / URL 必须使用 HTTPS");
        body = {
          ...source,
          contents: [{
            role: "user",
            parts: [
              {
                file_data: { file_uri: videoUri, mime_type: mimeType },
                ...(typeof mediaResolution === "string" && mediaResolution ? { media_resolution: mediaResolution } : {}),
              },
              { text: typeof prompt === "string" ? prompt : "请描述视频中的关键事件，并概括画面与音频信息。" },
            ],
          }],
        };
      } else {
        body = {
          ...source,
          contents: [{ role: "user", parts: [{ text: typeof prompt === "string" ? prompt : "请回复：模型连接测试成功" }] }],
        };
      }
      if (target.capability === "VIDEO_UNDERSTANDING") validateGeminiVideoPayload(body);
    } else if (protocol === "lingkeai_media") {
      const prompt = source.prompt;
      const providedParams = asObject(source.params);
      delete source.prompt;
      delete source.params;
      body = { model: requestModel, prompt: typeof prompt === "string" ? prompt : "模型连接测试", params: { ...source, ...providedParams } };
    } else if (protocol === "allaiin_rest") {
      body = { ...source };
      if (!body.model && !body.model_id) {
        const numericId = Number(modelConfig.remote_numeric_id);
        if (Number.isInteger(numericId) && numericId > 0) body.model_id = numericId;
        else body.model = requestModel;
      }
    } else {
      body = { ...source, model: source.model || requestModel };
      if ((protocol.includes("openai") || target.capability === "TEXT_GENERATION" || target.capability === "VIDEO_UNDERSTANDING") && !body.messages && typeof body.prompt === "string") {
        body.messages = [{ role: "user", content: body.prompt }];
        delete body.prompt;
      }
    }
    return {
      url: joinUrl(target.base_url, endpoint),
      method: String(modelConfig.test_generation_method || "POST").toUpperCase(),
      headers: this.authHeaders(providerConfig, modelConfig, apiKey),
      body,
    };
  }

  private queryRequest(
    target: TestTargetRow,
    taskId: string,
    modelConfig: Record<string, unknown>,
    providerConfig: Record<string, unknown>,
    apiKey: string,
  ): { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> } {
    const method = String(modelConfig.test_query_method || "GET").toUpperCase();
    const parameter = String(modelConfig.test_query_task_parameter || "task_id");
    const hasPlaceholder = target.query_endpoint!.includes("{task_id}");
    const endpoint = target.query_endpoint!.replaceAll("{task_id}", encodeURIComponent(taskId));
    let url = joinUrl(target.base_url, endpoint);
    let body: Record<string, unknown> | undefined;
    if (!hasPlaceholder && method === "GET") {
      const parsed = new URL(url);
      parsed.searchParams.set(parameter, taskId);
      url = parsed.toString();
    } else if (!hasPlaceholder) {
      body = { [parameter]: taskId };
    }
    return { url, method, headers: this.authHeaders(providerConfig, modelConfig, apiKey), body };
  }

  private async fetchUpstream(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; text: string; contentType: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body || {}),
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
        contentType: response.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
