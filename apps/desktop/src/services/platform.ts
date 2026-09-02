import { invoke } from "@tauri-apps/api/core";
import { platformApiBaseUrl, platformApiEnvironment } from "./apiConfig";
import type { CreativeTypePreset, VisualStylePreset } from "@aivs/schemas";

export { platformApiBaseUrl } from "./apiConfig";
const BROWSER_SESSION_KEY = "aivs.platform-session";
const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface PlatformSession {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  user_id?: string;
}

export interface PlatformUser {
  balance_fen: number;
  id: string;
  pid: string | null;
  invite_code: string;
  email: string | null;
  phone: string | null;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  credit_balance: number;
  held_credits: number;
  available_credits: number;
  created_at: string;
  updated_at: string;
}

export interface PlatformTokenResult {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  user: PlatformUser;
}

export interface PlatformCreditBalance { balance: number; held: number; available: number }
export interface PlatformCreditPackage {
  id: string; code: string; name: string; description: string; base_credits: number; bonus_credits: number;
  total_credits: number; price_fen: number; currency: string; status: string; sort_order: number;
}
export interface PlatformPurchase {
  id: string; purchase_no?: string; package_id: string; package_name_snapshot?: string; credits_granted?: number;
  credits?: number; paid_amount_fen?: number; amount_fen?: number; currency: string; status: string; code_url?: string;
  out_trade_no?: string; expires_at?: string; paid_at?: string; purchased_at?: string; created_at?: string;
}
export interface PlatformConsumption {
  id: string; consumption_no: string; task_id: string | null; provider_model_id: string | null; model_alias: string | null;
  model_code: string | null; category: string; credits_consumed: number; status: string; description: string; occurred_at: string;
}
export interface WechatQrSession { state: string; login_url: string; expires_at: string; status?: string; requires_follow?: boolean }
export interface CatalogCategory { id: string; code: string; name: string; description: string; sort_order: number }
export interface PlatformMediaResolutionPrice { resolution: string; credit_cost: number; label?: string }
export interface PlatformMediaModel {
  id: string; provider_id: string; provider_name: string; model_code: string; display_name: string; model_alias: string;
  capability: "IMAGE_GENERATION" | "VIDEO_GENERATION"; billing_unit: "PER_REQUEST" | "PER_SECOND";
  max_reference_images: number; supports_reference_video: boolean; supports_real_person: boolean;
  resolution_prices: PlatformMediaResolutionPrice[];
  generation_notice?: string;
}

export class PlatformApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) { super(message); }
}

let sessionCache: PlatformSession | null | undefined;
let refreshPromise: Promise<PlatformSession> | null = null;

function browserSession(): PlatformSession | null {
  try { return JSON.parse(localStorage.getItem(BROWSER_SESSION_KEY) || "null") as PlatformSession | null; } catch { return null; }
}

export async function loadPlatformSession(): Promise<PlatformSession | null> {
  if (sessionCache !== undefined) return sessionCache;
  sessionCache = isTauri() ? await invoke<PlatformSession | null>("get_platform_session") : browserSession();
  return sessionCache;
}

async function persistPlatformSession(session: PlatformSession | null): Promise<void> {
  sessionCache = session;
  if (isTauri()) {
    if (session) {
      await invoke("save_platform_session", { session });
      if (session.user_id) void invoke("activate_user_context").catch((error) => console.error("用户数据后台初始化失败", error));
    }
    else await invoke("clear_platform_session");
  } else if (session) localStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(BROWSER_SESSION_KEY);
}

function sessionFrom(result: PlatformTokenResult): PlatformSession {
  return { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: new Date(Date.now() + Math.max(60, result.expires_in) * 1000).toISOString(), user_id: result.user.id };
}

export async function bindPlatformSessionUser(userId: string): Promise<void> {
  const session = await loadPlatformSession();
  if (!session || session.user_id === userId) return;
  await persistPlatformSession({ ...session, user_id: userId });
}

export async function activatePlatformUserContext(): Promise<void> {
  if (isTauri()) await invoke("activate_user_context");
}

async function responseValue<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
  if (!response.ok) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const message = Array.isArray(object.message) ? object.message.join("；") : String(object.message || object.error || raw || `HTTP ${response.status}`);
    throw new PlatformApiError(message, response.status, value);
  }
  return value as T;
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${platformApiBaseUrl}${path}`, init);
  } catch (error) {
    const hint = platformApiEnvironment === "development"
      ? "请确认本地 API 已在 3101 端口启动（npm run dev:server）"
      : "请检查网络、HTTPS 证书和服务端可用性";
    throw new PlatformApiError(`无法连接 API 服务 ${platformApiBaseUrl}。${hint}`, 0, error);
  }
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return responseValue<T>(await apiFetch(path, { ...init, headers }));
}

async function refreshSession(session: PlatformSession): Promise<PlatformSession> {
  if (!refreshPromise) {
    refreshPromise = publicRequest<PlatformTokenResult>("/auth/refresh", {
      method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token, device_name: "AI Video Studio Desktop" }),
    }).then(async (result) => { const next = sessionFrom(result); await persistPlatformSession(next); return next; })
      .catch(async (error) => { await persistPlatformSession(null); throw error; })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function authenticatedRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  let session = await loadPlatformSession();
  if (!session) throw new PlatformApiError("请先登录平台账户", 401);
  if (new Date(session.expires_at).getTime() <= Date.now() + 30_000) session = await refreshSession(session);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await apiFetch(path, { ...init, headers });
  if (response.status === 401 && retry) {
    const refreshed = await refreshSession(session);
    headers.set("Authorization", `Bearer ${refreshed.access_token}`);
    return responseValue<T>(await apiFetch(path, { ...init, headers }));
  }
  return responseValue<T>(response);
}

async function acceptToken(result: PlatformTokenResult): Promise<PlatformTokenResult> {
  await persistPlatformSession(sessionFrom(result));
  return result;
}

export interface RegistrationCaptcha { captcha_id: string; image_data_url: string; expires_in: number }
export const checkRegistrationEmail = (email: string) => publicRequest<{ email: string; registered: boolean }>("/auth/email/status", { method: "POST", body: JSON.stringify({ email }) });
export interface RegistrationCaptchaVerification { captcha_token: string; expires_in: number }
export interface RegistrationEmailCodeResult { sent: boolean; expires_in: number; retry_after_seconds: number }
export const createRegistrationCaptcha = (email: string) => publicRequest<RegistrationCaptcha>("/auth/register/email/captcha", { method: "POST", body: JSON.stringify({ email }) });
export const verifyRegistrationCaptcha = (input: { email: string; captcha_id: string; answer: string }) => publicRequest<RegistrationCaptchaVerification>("/auth/register/email/captcha/verify", { method: "POST", body: JSON.stringify(input) });
export const sendRegistrationEmailCode = (input: { email: string; captcha_token: string }) => publicRequest<RegistrationEmailCodeResult>("/auth/register/email/code", { method: "POST", body: JSON.stringify(input) });

export async function registerPlatformEmail(input: { email: string; password: string; email_code: string; display_name?: string; invite_code?: string }) {
  return acceptToken(await publicRequest<PlatformTokenResult>("/auth/register/email", { method: "POST", body: JSON.stringify(input) }));
}
export async function registerPlatformPhone(input: { phone: string; password: string; display_name?: string }) {
  return acceptToken(await publicRequest<PlatformTokenResult>("/auth/register/phone", { method: "POST", body: JSON.stringify(input) }));
}
export async function loginPlatform(input: { identifier: string; password: string }) {
  return acceptToken(await publicRequest<PlatformTokenResult>("/auth/login", { method: "POST", body: JSON.stringify({ ...input, device_name: "AI Video Studio Desktop" }) }));
}
export async function logoutPlatform(): Promise<void> {
  try { if (await loadPlatformSession()) await authenticatedRequest("/auth/logout", { method: "POST" }, false); } finally { await persistPlatformSession(null); }
}
export const getPlatformUser = () => authenticatedRequest<PlatformUser>("/users/me");
export const updatePlatformUser = (input: Record<string, unknown>) => authenticatedRequest<PlatformUser>("/users/me", { method: "PATCH", body: JSON.stringify(input) });
export const listCreditPackages = () => publicRequest<PlatformCreditPackage[]>("/credits/packages");
export const getCreditBalance = () => authenticatedRequest<PlatformCreditBalance>("/credits/balance");
export interface ModelCreditQuote {
  provider_model_id: string; model_alias: string; model_code: string;
  capability: string; credits: number; resolution: string | null; seconds: number | null;
  includes_multiplier: boolean;
}
export const getModelCreditQuote = (capability: "TEXT_GENERATION" | "VIDEO_UNDERSTANDING") =>
  authenticatedRequest<ModelCreditQuote>("/tasks/quote", { method: "POST", body: JSON.stringify({ capability, payload: {} }) });
export const getMediaCreditQuote = (providerModelId: string, resolution: string, seconds?: number) =>
  authenticatedRequest<ModelCreditQuote>("/tasks/quote", { method: "POST", body: JSON.stringify({ provider_model_id: providerModelId, payload: { resolution, seconds } }) });
export const listCreditPurchases = () => authenticatedRequest<PlatformPurchase[]>("/credits/purchases");
export const listCreditConsumptions = () => authenticatedRequest<PlatformConsumption[]>("/credits/consumptions");
export const createCreditPurchase = (packageId: string) => authenticatedRequest<PlatformPurchase>("/credits/purchases", { method: "POST", body: JSON.stringify({ package_id: packageId, idempotency_key: crypto.randomUUID() }) });
export const getCreditPurchase = (purchaseId: string) => authenticatedRequest<PlatformPurchase>(`/credits/purchases/${encodeURIComponent(purchaseId)}`);
export const createWechatQrSession = (invite_code?: string) => publicRequest<WechatQrSession>("/auth/wechat/qr-sessions", { method: "POST", body: JSON.stringify({ invite_code }) });

export interface ReferralSummary {
  invite_code: string; invitation_url: string; invited_count: number; reward_credits: number; invitation_reward_credits: number;
  enabled: boolean; direct_rate_bps: number; indirect_rate_bps: number; minimum_withdrawal_fen: number;
  available_fen: number; frozen_fen: number; earned_fen: number; paid_fen: number;
  withdrawal_open: boolean; timezone: string; server_time: string; next_open_at: string;
}
export interface ReferralRecord { id: string; amount_fen?: number | string; base_amount_fen?: number | string; rate_bps?: number; level?: number; status?: string; review_note?: string; created_at: string; paid_at?: string; credits?: number; payer_id?: string; invited_user_id?: string; alipay_trade_no?: string }
export interface ReferralPage { items: ReferralRecord[]; page: number; has_more: boolean }
export const getReferralSummary = () => authenticatedRequest<ReferralSummary>("/referrals/me");
export const getReferralRecords = (kind: string, page = 1) => authenticatedRequest<ReferralPage>(`/referrals/me/${encodeURIComponent(kind)}?page=${page}`);
export const applyReferralWithdrawal = (input: { amount_fen: number; idempotency_key: string; alipay_real_name: string; alipay_account: string; alipay_qr_code: string }) => authenticatedRequest<{ id: string; status: string }>("/referrals/withdrawals", { method: "POST", body: JSON.stringify(input) });
export const listVisualStyleCategories = () => publicRequest<CatalogCategory[]>("/client-config/visual-style-categories");
export const listVisualStyles = () => publicRequest<VisualStylePreset[]>("/client-config/visual-styles");
export const listCreativeTypeCategories = () => publicRequest<CatalogCategory[]>("/client-config/creative-type-categories");
export const listCreativeTypes = () => publicRequest<CreativeTypePreset[]>("/client-config/creative-types");
export async function listMediaModels(capability: PlatformMediaModel["capability"]): Promise<PlatformMediaModel[]> {
  const models = await publicRequest<PlatformMediaModel[]>("/client-config/models");
  return models.filter((model) => model.capability === capability && model.resolution_prices.length > 0);
}
export const pollWechatQrSession = async (state: string, shouldAccept: () => boolean = () => true) => {
  const result = await publicRequest<Record<string, unknown>>(`/auth/wechat/qr-sessions/status?state=${encodeURIComponent(state)}&device_name=${encodeURIComponent("AI Video Studio Desktop")}`);
  if (shouldAccept() && typeof result.access_token === "string" && typeof result.refresh_token === "string") await acceptToken(result as unknown as PlatformTokenResult);
  return result;
};

export async function clearInvalidPlatformSession(): Promise<void> { await persistPlatformSession(null); }
