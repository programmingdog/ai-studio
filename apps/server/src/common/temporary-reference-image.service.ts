import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EnvironmentService } from "../config/environment.service";

const pendingLifetimeMs = 60 * 60 * 1000;
const consumedGraceMs = 10 * 60 * 1000;
const maximumFileBytes = 10 * 1024 * 1024;
const maximumStoredBytes = 2 * 1024 * 1024 * 1024;
const maximumStoredFiles = 5_000;
const publicPath = "/api/v1/temporary-reference-images/";

type TokenPayload = { n: string; e: number; m: string; s: number; u: string };
type UploadedFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };

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

  constructor(@Inject(EnvironmentService) environment: EnvironmentService) {
    this.root = environment.values.referenceImageDirectory;
    this.signingKey = createHash("sha256").update(`aivs-reference-image\0${environment.values.credentialEncryptionKey}`).digest();
  }

  async onModuleInit() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup().catch(error => this.logger.warn({
      event: "temporary_reference.cleanup_failed",
      error: error instanceof Error ? error.message : "临时参考图定时清理失败",
    })), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }

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
    const payload: TokenPayload = { n: nonce, e: expiresAt, m: mime, s: file.size, u: this.userFingerprint(userId) };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `${encoded}.${this.signature(encoded)}`;
    await writeFile(this.path(nonce, "pending"), file.buffer, { flag: "wx", mode: 0o600 });
    return { url: new URL(`${publicPath}${token}`, base).toString(), expires_at: new Date(expiresAt).toISOString(), size: file.size, mime_type: mime };
  }

  async open(token: string) {
    const payload = this.verify(token);
    if (payload.e <= Date.now()) { await this.removeNonce(payload.n); throw new BadRequestException("临时参考图已过期"); }
    for (const state of ["pending", "consumed"] as const) {
      const filePath = this.path(payload.n, state);
      try {
        const info = await stat(filePath);
        if (!info.isFile() || info.size !== payload.s) break;
        return { stream: createReadStream(filePath), mimeType: payload.m, size: payload.s };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw new BadRequestException("临时参考图不存在或已清理");
  }

  ownedTokens(payload: Record<string, unknown>, userId: string): string[] {
    const values = [payload.reference_images, this.object(payload.params).reference_images];
    const tokens = new Set<string>();
    for (const value of values) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const source = this.object(item);
        const raw = typeof item === "string" ? item : String(source.url || source.data_url || "");
        let url: URL;
        try { url = new URL(raw); } catch { continue; }
        const marker = url.pathname.indexOf(publicPath);
        if (marker < 0) continue;
        const token = decodeURIComponent(url.pathname.slice(marker + publicPath.length));
        const decoded = this.verify(token);
        if (decoded.u !== this.userFingerprint(userId)) throw new BadRequestException("临时参考图不属于当前登录用户");
        if (decoded.e <= Date.now()) throw new BadRequestException("临时参考图已过期，请重新上传");
        tokens.add(token);
      }
    }
    return [...tokens];
  }

  async markConsumed(tokens: string[]) {
    for (const token of tokens) {
      const payload = this.verify(token);
      try { await rename(this.path(payload.n, "pending"), this.path(payload.n, "consumed")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const timer = setTimeout(() => void this.removeNonce(payload.n).catch(error => this.logger.warn({
        event: "temporary_reference.consumed_cleanup_failed",
        error: error instanceof Error ? error.message : "已使用临时参考图清理失败",
      })), consumedGraceMs);
      timer.unref();
    }
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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const name of await readdir(this.root)) {
      if (!/^[A-Za-z0-9_-]{32}\.(?:pending|consumed)$/.test(name)) continue;
      try {
        const info = await stat(join(this.root, name));
        const lifetime = name.endsWith(".consumed") ? consumedGraceMs : pendingLifetimeMs;
        if (now - info.mtimeMs >= lifetime) await unlink(join(this.root, name));
      } catch { /* A concurrent request may already have renamed/deleted it. */ }
    }
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
      || !["image/png", "image/jpeg", "image/webp"].includes(payload.m) || !/^[A-Za-z0-9_-]{32}$/.test(payload.u)) {
      throw new BadRequestException("临时参考图令牌内容无效");
    }
    return payload;
  }

  private signature(encoded: string) { return createHmac("sha256", this.signingKey).update(encoded).digest("base64url"); }
  private userFingerprint(userId: string) { return createHmac("sha256", this.signingKey).update(`user\0${userId}`).digest("base64url").slice(0, 32); }
  private path(nonce: string, state: "pending" | "consumed") { return join(this.root, `${nonce}.${state}`); }
  private async removeNonce(nonce: string) {
    await Promise.all(["pending", "consumed"].map(state => unlink(join(this.root, `${nonce}.${state}`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
  }
  private object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
}
