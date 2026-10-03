export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3101/api/v1";
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: Record<string, unknown>) { super(message); }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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

/** Keep multipart boundaries browser-generated and expose actual upload progress. */
export function apiUpload<T>(path: string, file: File, token: string, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    request.open("POST", `${API_BASE}${path}`);
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.timeout = 30 * 60 * 1000;
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    request.onload = () => {
      cleanup();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(request.responseText) as Record<string, unknown>; } catch { /* Report malformed success responses below. */ }
      const applicationStatus = typeof body.status === "number" ? body.status : undefined;
      if (request.status < 200 || request.status >= 300 || (applicationStatus !== undefined && applicationStatus >= 400)) {
        const rawMessage = body.message ?? body.msg;
        reject(new ApiError(Array.isArray(rawMessage) ? rawMessage.join("；") : typeof rawMessage === "string" ? rawMessage : `上传失败（${request.status}）`, request.status, body));
      } else if (!Object.keys(body).length) reject(new Error("上传完成，但服务端返回了无效结果"));
      else resolve(body as T);
    };
    request.onerror = () => { cleanup(); reject(new Error("媒体上传失败，请检查网络后重试")); };
    request.ontimeout = () => { cleanup(); reject(new Error("媒体上传超时，请重试")); };
    request.onabort = () => { cleanup(); reject(new DOMException("上传已取消", "AbortError")); };
    if (signal?.aborted) { reject(new DOMException("上传已取消", "AbortError")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    const data = new FormData();
    data.append("file", file);
    request.send(data);
  });
}
