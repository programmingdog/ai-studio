import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { EnvironmentService } from "../config/environment.service";
import { DatabaseService } from "../database/database.service";

const pendingLifetimeMs = 60 * 60 * 1000;
const terminalGraceMs = 60 * 60 * 1000;
const maximumFileBytes = 10 * 1024 * 1024;
const maximumStoredBytes = 2 * 1024 * 1024 * 1024;
const maximumStoredFiles = 5_000;
const publicPath = "/api/v1/temporary-reference-images/";
const readinessAttempts = 6;

type TokenPayload = { n: string; e: number; m: string; s: number; u: string; v?: number };
type UploadedFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };
interface ImageRow extends RowDataPacket {
  nonce: string; owner_fingerprint: string; mime_type: string; byte_size: number;
  upload_expires_at: Date; state: string;
}
interface TaskLifetimeRow extends RowDataPacket { status: string; finished_at: Date | null }
const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

function retained(image: ImageRow, tasks: TaskLifetimeRow[], now: number): boolean {
  if (image.state !== "AVAILABLE") return false;
  if (!tasks.length) return new Date(image.upload_expires_at).getTime() > now;
  // Unknown states / missing terminal timestamps are deliberately fail-safe.
  return tasks.some(task => !terminalStatuses.has(task.status) || !task.finished_at
    || !Number.isFinite(new Date(task.finished_at).getTime())
    || new Date(task.finished_at).getTime() + terminalGraceMs > now);
}

function detectedMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

@Injectable()
export class TemporaryReferenceImageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporaryReferenceImageService.name);
  private readonly root: string;
  private readonly signingKey: Buffer;
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupRunning = false;

  constructor(@Inject(EnvironmentService) environment: EnvironmentService,
    @Inject(DatabaseService) private readonly database: DatabaseService) {
    this.root = environment.values.referenceImageDirectory;
    this.signingKey = createHash("sha256").update(`aivs-reference-image\0${environment.values.credentialEncryptionKey}`).digest();
  }

  async onModuleInit() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // A pending migration / unavailable cleanup DB must not prevent unrelated
    // APIs (including text-generation quotes) from starting. Upload/binding
    // still require the schema and fail closed before any upstream submission.
    await this.cleanup().catch(error => this.reportCleanupError(error));
    this.cleanupTimer = setInterval(() => void this.cleanup().catch(error => this.reportCleanupError(error)), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }

  private reportCleanupError(error: unknown) {
    this.logger.warn({ event: "temporary_reference.cleanup_failed",
      error: (error as NodeJS.ErrnoException)?.code === "ER_NO_SUCH_TABLE"
        ? "参考图生命周期表尚未创建，请执行 056 数据库迁移；已暂停参考图清理"
        : error instanceof Error ? error.message : "临时参考图清理失败，保留现有文件" });
  }

  async upload(userId: string, file: UploadedFile | undefined, origin: string) {
    if (!file?.buffer?.length || file.size !== file.buffer.length) throw new BadRequestException("请选择有效的参考图");
    if (file.size > maximumFileBytes) throw new BadRequestException("单张临时参考图不能超过 10MB");
    const mime = detectedMime(file.buffer);
    if (!mime) throw new BadRequestException("临时参考图仅支持 PNG、JPEG 或 WebP");
    let base: URL;
    try { base = new URL(origin); } catch { throw new BadRequestException("无法生成临时参考图公网地址"); }
    if (!(["https:", "http:"].includes(base.protocol)) || base.username || base.password) throw new BadRequestException("临时参考图公网地址无效");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertCapacity(file.size);
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + pendingLifetimeMs;
    // e limits admission to NEW tasks, not downloads by an already bound task.
    const payload: TokenPayload = { n: nonce, e: expiresAt, m: mime, s: file.size, u: this.userFingerprint(userId), v: 2 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `${encoded}.${this.signature(encoded)}`;
    await writeFile(this.path(nonce, "image"), file.buffer, { flag: "wx", mode: 0o600 });
    // A crash between the file and DB writes leaves an unbound orphan, never a
    // prematurely deleted task image. The periodic sweep reclaims that orphan.
    await this.database.execute(
      "INSERT INTO temporary_reference_images (nonce, owner_fingerprint, mime_type, byte_size, upload_expires_at) VALUES (?, ?, ?, ?, ?)",
      [nonce, payload.u, mime, file.size, new Date(expiresAt)],
    );
    return { url: new URL(`${publicPath}${token}`, base).toString(), expires_at: new Date(expiresAt).toISOString(), lifetime: "task", size: file.size, mime_type: mime };
  }

  async open(token: string) {
    const payload = this.verify(token);
    return this.database.transaction(async connection => {
      const image = await this.lockImage(connection, payload.n);
      if (image) {
        this.assertMatches(image, payload);
        if (!retained(image, await this.taskLifetimes(connection, payload.n), Date.now())) throw new BadRequestException("临时参考图已过期或任务已结束");
      } else if (payload.v === 2 || payload.e <= Date.now()) {
        throw new BadRequestException("临时参考图已过期或不存在");
      }
      // Hold the same row lock as binding / cleanup until the descriptor is
      // open. A subsequent unlink does not interrupt an in-flight download.
      return this.openFile(payload);
    });
  }

  private async openFile(payload: TokenPayload) {
    for (const state of ["image", "pending", "consumed"] as const) {
      const filePath = this.path(payload.n, state);
      try {
        const handle = await open(filePath, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== payload.s) {
            await handle.close();
            break;
          }
          return { stream: handle.createReadStream(), mimeType: payload.m, size: payload.s };
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw new BadRequestException("临时参考图不存在或已清理");
  }

  ownedTokens(payload: Record<string, unknown>, userId: string): string[] {
    const tokens = new Set<string>();
    for (const value of this.referenceValues(payload)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        const source = this.object(item);
        const raw = typeof item === "string" ? item : String(source.url || source.data_url || "");
        let url: URL;
        try { url = new URL(raw); } catch { continue; }
        const marker = url.pathname.indexOf(publicPath);
        if (marker < 0) continue;
        const token = decodeURIComponent(url.pathname.slice(marker + publicPath.length));
        const decoded = this.verify(token);
        if (decoded.u !== this.userFingerprint(userId)) throw new BadRequestException("临时参考图不属于当前登录用户");
        // Check admission expiry only in bindToTask, after idempotent replay.
        tokens.add(token);
      }
    }
    return [...tokens];
  }

  async assertPubliclyReachable(payload: Record<string, unknown>, userId: string): Promise<void> {
    const urls = new Set<string>();
    for (const value of this.referenceValues(payload)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        const source = this.object(item);
        const raw = typeof item === "string" ? item : String(source.url || source.data_url || "");
        let url: URL;
        try { url = new URL(raw); } catch { continue; }
        if (!url.pathname.includes(publicPath)) continue;
        const token = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(publicPath) + publicPath.length));
        const decoded = this.verify(token);
        if (decoded.u !== this.userFingerprint(userId)) throw new BadRequestException("临时参考图不属于当前登录用户");
        this.assertExternalHttps(url);
        urls.add(url.toString());
      }
    }
    for (const url of urls) await this.waitUntilReachable(url);
  }

  async bindToTask(connection: PoolConnection, tokens: string[], taskId: string, userId: string) {
    // Same lock order for shared references prevents concurrent bind deadlocks.
    for (const token of [...new Set(tokens)].sort()) {
      const payload = this.verify(token);
      if (payload.u !== this.userFingerprint(userId)) throw new BadRequestException("临时参考图不属于当前登录用户");
      if (payload.e <= Date.now()) throw new BadRequestException("临时参考图已过期，请重新上传");
      let image = await this.lockImage(connection, payload.n);
      // Permit an old client's still-valid upload to be bound during rollout.
      if (!image && payload.v !== 2) {
        await connection.execute(
          "INSERT INTO temporary_reference_images (nonce, owner_fingerprint, mime_type, byte_size, upload_expires_at) VALUES (?, ?, ?, ?, ?)",
          [payload.n, payload.u, payload.m, payload.s, new Date(payload.e)],
        );
        image = await this.lockImage(connection, payload.n);
      }
      if (!image || image.state !== "AVAILABLE") throw new BadRequestException("临时参考图不存在或已清理，请重新上传");
      this.assertMatches(image, payload);
      const file = await this.openFile(payload);
      file.stream.destroy();
      await connection.execute("INSERT IGNORE INTO task_reference_images (image_nonce, task_id) VALUES (?, ?)", [payload.n, taskId]);
    }
  }

  private async lockImage(connection: PoolConnection, nonce: string) {
    const [rows] = await connection.query<ImageRow[]>("SELECT * FROM temporary_reference_images WHERE nonce = ? FOR UPDATE", [nonce]);
    return rows[0];
  }

  private async taskLifetimes(connection: PoolConnection, nonce: string) {
    const [rows] = await connection.query<TaskLifetimeRow[]>(
      "SELECT t.status, t.finished_at FROM task_reference_images r INNER JOIN ai_tasks t ON t.id = r.task_id WHERE r.image_nonce = ?", [nonce]);
    return rows;
  }

  private assertMatches(image: ImageRow, payload: TokenPayload) {
    if (image.owner_fingerprint !== payload.u || image.mime_type !== payload.m || Number(image.byte_size) !== payload.s
      || new Date(image.upload_expires_at).getTime() !== payload.e) throw new BadRequestException("临时参考图令牌与文件不匹配");
  }

  private async assertCapacity(incoming: number) {
    const names = await readdir(this.root);
    if (names.length >= maximumStoredFiles) throw new ServiceUnavailableException("临时参考图空间正在清理，请稍后重试");
    let total = 0;
    for (const name of names) {
      try { total += (await stat(join(this.root, name))).size; } catch { /* Concurrent cleanup is harmless. */ }
      if (total + incoming > maximumStoredBytes) throw new ServiceUnavailableException("临时参考图空间不足，请稍后重试");
    }
  }

  private async cleanup() {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const now = Date.now();
      // Scan in one query; only take per-image locks for cleanup candidates.
      const candidates = await this.database.query<ImageRow[]>(
        `SELECT i.nonce FROM temporary_reference_images i
         LEFT JOIN task_reference_images r ON r.image_nonce = i.nonce
         LEFT JOIN ai_tasks t ON t.id = r.task_id
         GROUP BY i.nonce, i.state, i.upload_expires_at
         HAVING i.state = 'DELETING'
           OR (COUNT(r.task_id) = 0 AND i.upload_expires_at <= ?)
           OR (COUNT(r.task_id) > 0 AND SUM(CASE
             WHEN t.status IN ('SUCCEEDED', 'FAILED', 'CANCELED') AND t.finished_at IS NOT NULL AND t.finished_at <= ?
             THEN 0 ELSE 1 END) = 0)`, [new Date(now), new Date(now - terminalGraceMs)],
      );
      for (const image of candidates) {
        const remove = await this.database.transaction(async connection => {
          const locked = await this.lockImage(connection, image.nonce);
          if (!locked || retained(locked, await this.taskLifetimes(connection, image.nonce), now)) return false;
          // Commit the deletion claim before unlinking. No new task can bind it.
          await connection.execute("UPDATE temporary_reference_images SET state = 'DELETING' WHERE nonce = ?", [image.nonce]);
          return true;
        });
        if (!remove) continue;
        await this.removeNonce(image.nonce);
        await this.database.execute("DELETE FROM temporary_reference_images WHERE nonce = ? AND state = 'DELETING'", [image.nonce]);
      }
      // Legacy uploads and files orphaned by interrupted upload writes. Recheck
      // the DB under a lock so adoption by bindToTask cannot race this sweep.
      const tracked = new Set((await this.database.query<ImageRow[]>("SELECT nonce FROM temporary_reference_images")).map(image => image.nonce));
      for (const name of await readdir(this.root)) {
        if (!/^[A-Za-z0-9_-]{32}\.(?:image|pending|consumed)$/.test(name) || tracked.has(name.slice(0, 32))) continue;
        await this.database.transaction(async connection => {
          if (await this.lockImage(connection, name.slice(0, 32))) return;
          try {
            const info = await stat(join(this.root, name));
            if (now - info.mtimeMs >= pendingLifetimeMs) await unlink(join(this.root, name));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        });
      }
    } finally { this.cleanupRunning = false; }
  }

  private verify(token: string): TokenPayload {
    const [encoded, supplied, extra] = token.split(".");
    if (!encoded || !supplied || extra || encoded.length > 1000) throw new BadRequestException("临时参考图令牌无效");
    const expected = Buffer.from(this.signature(encoded));
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException("临时参考图签名无效");
    let payload: TokenPayload;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
    catch { throw new BadRequestException("临时参考图令牌无效"); }
    if (!payload || !/^[A-Za-z0-9_-]{32}$/.test(payload.n) || !Number.isSafeInteger(payload.e)
      || !Number.isSafeInteger(payload.s) || payload.s < 1 || payload.s > maximumFileBytes
      || (payload.v !== undefined && payload.v !== 2)
      || !["image/png", "image/jpeg", "image/webp"].includes(payload.m) || !/^[A-Za-z0-9_-]{32}$/.test(payload.u)) {
      throw new BadRequestException("临时参考图令牌内容无效");
    }
    return payload;
  }

  private signature(encoded: string) { return createHmac("sha256", this.signingKey).update(encoded).digest("base64url"); }
  private userFingerprint(userId: string) { return createHmac("sha256", this.signingKey).update(`user\0${userId}`).digest("base64url").slice(0, 32); }
  private path(nonce: string, state: "image" | "pending" | "consumed") { return join(this.root, `${nonce}.${state}`); }
  private async removeNonce(nonce: string) {
    await Promise.all(["image", "pending", "consumed"].map(state => unlink(join(this.root, `${nonce}.${state}`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
  }
  private referenceValues(payload: Record<string, unknown>): unknown[] {
    const params = this.object(payload.params);
    return [payload.reference_images, params.reference_images, payload.reference_image, params.reference_image,
      payload.frame_start, params.frame_start, payload.frame_end, params.frame_end];
  }
  private assertExternalHttps(url: URL) {
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
    const privateIpv4 = ipv4 && (ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 || ipv4[0] === 169 && ipv4[1] === 254
      || ipv4[0] === 192 && ipv4[1] === 168 || ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31);
    const privateIpv6 = host === "::" || host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:");
    if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || privateIpv4 || privateIpv6) {
      throw new BadRequestException("慧心AI需要公网 HTTPS 参考图，当前平台返回的是本机或内网地址；请配置公网域名/反向代理后重试");
    }
  }
  private async waitUntilReachable(url: string) {
    let detail = "尚未返回图片内容";
    for (let attempt = 1; attempt <= readinessAttempts; attempt++) {
      try {
        const response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
        this.assertExternalHttps(new URL(response.url));
        const image = (response.headers.get("content-type") || "").toLowerCase().startsWith("image/");
        const body = response.ok && image ? await response.arrayBuffer() : null;
        if (body?.byteLength) return;
        detail = `HTTP ${response.status}，且未返回有效图片`;
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        detail = "公网探测连接失败或超时";
      }
      if (attempt < readinessAttempts) await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    throw new ServiceUnavailableException(`参考图上传后仍无法通过公网访问（${detail}），请检查公网域名、反向代理以及多实例共享存储`);
  }
  private object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
}
