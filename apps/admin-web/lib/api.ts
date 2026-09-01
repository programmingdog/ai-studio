export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3101/api/v1";
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: Record<string, unknown>) { super(message); }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const applicationStatus = typeof body.status === "number" ? body.status : undefined;
  if (!response.ok || (applicationStatus !== undefined && applicationStatus >= 400)) {
    const rawMessage = body.message ?? body.msg;
    const message = Array.isArray(rawMessage) ? rawMessage.join("；") : rawMessage;
    throw new ApiError(typeof message === "string" ? message : `请求失败（${response.status}）`, response.status, body);
  }
  return body as T;
}
