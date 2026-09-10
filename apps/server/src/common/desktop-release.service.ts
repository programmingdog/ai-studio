import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AuditService } from "./audit.service";
import { DatabaseService } from "../database/database.service";

export const DESKTOP_RELEASE_TARGETS = ["windows", "darwin"] as const;
export const DESKTOP_RELEASE_ARCHES = ["x86_64", "aarch64"] as const;
export type DesktopReleaseTarget = typeof DESKTOP_RELEASE_TARGETS[number];
export type DesktopReleaseArch = typeof DESKTOP_RELEASE_ARCHES[number];
export type DesktopReleaseArtifactInput = { target: string; arch: string; url: string; signature: string };
export type DesktopReleaseInput = {
  version: string;
  channel: string;
  notes: string;
  minSupportedVersion: string;
  rolloutPercent: number;
  artifacts: DesktopReleaseArtifactInput[];
};

export interface ReleaseRow extends RowDataPacket {
  id: string;
  version: string;
  channel: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  notes: string;
  min_supported_version: string;
  rollout_percent: number;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
}

export interface ArtifactRow extends RowDataPacket {
  id: string;
  release_id: string;
  target: DesktopReleaseTarget;
  arch: DesktopReleaseArch;
  url: string;
  signature: string;
}

type Semver = { major: number; minor: number; patch: number; prerelease: Array<string | number> };

export function parseDesktopVersion(value: string): Semver | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) return null;
  const prereleaseParts = match[4]?.split(".") || [];
  if (prereleaseParts.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: prereleaseParts.map((part) => /^\d+$/.test(part) ? Number(part) : part),
  };
}

export function compareDesktopVersions(left: string, right: string): number {
  const a = parseDesktopVersion(left);
  const b = parseDesktopVersion(right);
  if (!a || !b) throw new BadRequestException("客户端版本号必须遵循 SemVer，例如 1.2.3 或 1.2.3-beta.1");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

@Injectable()
export class DesktopReleaseService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    const releases = await this.database.query<ReleaseRow[]>(
      `SELECT id, version, channel, status, notes, min_supported_version, rollout_percent,
              created_at, updated_at, published_at
       FROM desktop_releases
       ORDER BY created_at DESC`,
    );
    const artifacts = await this.database.query<ArtifactRow[]>(
      `SELECT id, release_id, target, arch, url, signature
       FROM desktop_release_artifacts
       ORDER BY target, arch`,
    );
    return releases.map((release) => this.present(release, artifacts.filter((artifact) => artifact.release_id === release.id)));
  }

  async create(adminUserId: string, rawInput: DesktopReleaseInput) {
    const input = this.validate(rawInput);
    const id = randomUUID();
    try {
      await this.database.transaction(async (connection) => {
        await connection.execute(
          `INSERT INTO desktop_releases
            (id, version, channel, status, notes, min_supported_version, rollout_percent, created_by)
           VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
          [id, input.version, input.channel, input.notes, input.minSupportedVersion, input.rolloutPercent, adminUserId],
        );
        await this.replaceArtifacts(connection, id, input.artifacts);
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new ConflictException("该渠道已存在相同版本号");
      throw error;
    }
    await this.audit.record({ adminUserId, action: "desktop_release.create", entityType: "desktop_release", entityId: id, details: { version: input.version, channel: input.channel } });
    return this.get(id);
  }

  async update(adminUserId: string, id: string, rawInput: DesktopReleaseInput) {
    const existing = await this.release(id);
    if (existing.status !== "DRAFT") throw new ConflictException("已发布版本不可修改；请归档后创建新版本");
    const input = this.validate(rawInput);
    try {
      await this.database.transaction(async (connection) => {
        await connection.execute(
          `UPDATE desktop_releases
           SET version = ?, channel = ?, notes = ?, min_supported_version = ?, rollout_percent = ?
           WHERE id = ? AND status = 'DRAFT'`,
          [input.version, input.channel, input.notes, input.minSupportedVersion, input.rolloutPercent, id],
        );
        await connection.execute("DELETE FROM desktop_release_artifacts WHERE release_id = ?", [id]);
        await this.replaceArtifacts(connection, id, input.artifacts);
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new ConflictException("该渠道已存在相同版本号");
      throw error;
    }
    await this.audit.record({ adminUserId, action: "desktop_release.update", entityType: "desktop_release", entityId: id, details: { version: input.version, channel: input.channel } });
    return this.get(id);
  }

  async publish(adminUserId: string, id: string) {
    const release = await this.release(id);
    if (release.status !== "DRAFT") throw new ConflictException("只有草稿版本可以发布");
    const artifacts = await this.artifacts(id);
    if (!artifacts.length) throw new BadRequestException("至少需要一个签名更新包才能发布");
    const published = await this.database.query<ReleaseRow[]>(
      `SELECT id, version, channel, status, notes, min_supported_version, rollout_percent,
              created_at, updated_at, published_at
       FROM desktop_releases
       WHERE channel = ? AND status IN ('PUBLISHED', 'ARCHIVED') AND id <> ?`,
      [release.channel, id],
    );
    const highest = published.sort((a, b) => compareDesktopVersions(b.version, a.version))[0];
    if (highest && compareDesktopVersions(release.version, highest.version) <= 0) {
      throw new ConflictException(`发布版本必须高于该渠道已发布过的 v${highest.version}`);
    }
    await this.database.execute(
      `UPDATE desktop_releases
       SET status = 'PUBLISHED', published_by = ?, published_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'DRAFT'`,
      [adminUserId, id],
    );
    await this.audit.record({ adminUserId, action: "desktop_release.publish", entityType: "desktop_release", entityId: id, details: { version: release.version, channel: release.channel, rollout_percent: Number(release.rollout_percent) } });
    return this.get(id);
  }

  async archive(adminUserId: string, id: string) {
    const release = await this.release(id);
    if (release.status !== "PUBLISHED") throw new ConflictException("只有已发布版本可以归档");
    await this.database.execute("UPDATE desktop_releases SET status = 'ARCHIVED' WHERE id = ? AND status = 'PUBLISHED'", [id]);
    await this.audit.record({ adminUserId, action: "desktop_release.archive", entityType: "desktop_release", entityId: id, details: { version: release.version, channel: release.channel } });
    return this.get(id);
  }

  async updateRollout(adminUserId: string, id: string, rolloutPercent: number) {
    const release = await this.release(id);
    if (release.status !== "PUBLISHED") throw new ConflictException("只有已发布版本可以调整灰度比例");
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 1 || rolloutPercent > 100) throw new BadRequestException("灰度比例必须是 1 到 100 的整数");
    await this.database.execute("UPDATE desktop_releases SET rollout_percent = ? WHERE id = ? AND status = 'PUBLISHED'", [rolloutPercent, id]);
    await this.audit.record({ adminUserId, action: "desktop_release.rollout", entityType: "desktop_release", entityId: id, details: { before: Number(release.rollout_percent), after: rolloutPercent } });
    return this.get(id);
  }

  async updateNotes(adminUserId: string, id: string, rawNotes: unknown) {
    const release = await this.release(id);
    if (typeof rawNotes !== "string") throw new BadRequestException("更新说明必须是文本");
    const notes = rawNotes.trim();
    if (notes.length > 20_000) throw new BadRequestException("更新说明不能超过 20000 个字符");
    await this.database.execute("UPDATE desktop_releases SET notes = ? WHERE id = ?", [notes, id]);
    await this.audit.record({ adminUserId, action: "desktop_release.notes", entityType: "desktop_release", entityId: id,
      details: { version: release.version, channel: release.channel, before: release.notes, after: notes } });
    return this.get(id);
  }

  async removeDraft(adminUserId: string, id: string) {
    const release = await this.release(id);
    if (release.status !== "DRAFT") throw new ConflictException("只能删除尚未发布的草稿");
    await this.database.execute("DELETE FROM desktop_releases WHERE id = ? AND status = 'DRAFT'", [id]);
    await this.audit.record({ adminUserId, action: "desktop_release.delete", entityType: "desktop_release", entityId: id, details: { version: release.version, channel: release.channel } });
    return { deleted: true };
  }

  async selectUpdate(input: { currentVersion: string; channel: string; target: string; arch: string; cohort: string }) {
    this.version(input.currentVersion, "当前客户端版本");
    const channel = this.channel(input.channel);
    const target = this.target(input.target);
    const arch = this.arch(input.arch);
    const releases = await this.database.query<ReleaseRow[]>(
      `SELECT id, version, channel, status, notes, min_supported_version, rollout_percent,
              created_at, updated_at, published_at
       FROM desktop_releases
       WHERE channel = ? AND status = 'PUBLISHED' AND published_at <= CURRENT_TIMESTAMP(3)`,
      [channel],
    );
    const candidates = releases
      .filter((release) => compareDesktopVersions(release.version, input.currentVersion) > 0)
      .sort((a, b) => compareDesktopVersions(b.version, a.version));
    for (const release of candidates) {
      const mandatory = compareDesktopVersions(input.currentVersion, release.min_supported_version) < 0;
      if (!mandatory && !this.inRollout(release, input.cohort)) continue;
      const [artifact] = await this.database.query<ArtifactRow[]>(
        `SELECT id, release_id, target, arch, url, signature
         FROM desktop_release_artifacts
         WHERE release_id = ? AND target = ? AND arch = ? LIMIT 1`,
        [release.id, target, arch],
      );
      if (!artifact) continue;
      return {
        version: release.version,
        notes: release.notes,
        pub_date: release.published_at,
        url: artifact.url,
        signature: artifact.signature,
        mandatory,
        min_supported_version: release.min_supported_version,
        rollout_percent: Number(release.rollout_percent),
      };
    }
    return null;
  }

  private validate(input: DesktopReleaseInput): DesktopReleaseInput {
    const version = this.version(input.version, "版本号");
    const minSupportedVersion = this.version(input.minSupportedVersion || "0.0.0", "最低可运行版本");
    if (compareDesktopVersions(minSupportedVersion, version) > 0) throw new BadRequestException("最低可运行版本不能高于发布版本");
    const rolloutPercent = Number(input.rolloutPercent);
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 1 || rolloutPercent > 100) throw new BadRequestException("灰度比例必须是 1 到 100 的整数");
    const artifacts = this.validateArtifacts(input.artifacts);
    return { version, minSupportedVersion, channel: this.channel(input.channel), notes: String(input.notes || "").trim().slice(0, 20000), rolloutPercent, artifacts };
  }

  private validateArtifacts(rawArtifacts: DesktopReleaseArtifactInput[]): DesktopReleaseArtifactInput[] {
    if (!Array.isArray(rawArtifacts) || rawArtifacts.length > 4) throw new BadRequestException("更新包列表无效");
    const keys = new Set<string>();
    return rawArtifacts.map((raw) => {
      const target = this.target(raw.target);
      const arch = this.arch(raw.arch);
      if (target === "windows" && arch === "aarch64") throw new BadRequestException("当前不支持 Windows ARM64 更新包");
      const key = `${target}:${arch}`;
      if (keys.has(key)) throw new BadRequestException(`更新包平台重复：${key}`);
      keys.add(key);
      let url: URL;
      try { url = new URL(String(raw.url || "").trim()); } catch { throw new BadRequestException(`更新包地址无效：${key}`); }
      if (url.protocol !== "https:") throw new BadRequestException("更新包必须使用 HTTPS 地址");
      if (url.username || url.password || url.hash) throw new BadRequestException("更新包地址不能包含账号、密码或片段");
      if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) throw new BadRequestException("更新包地址不能指向本机");
      const signature = String(raw.signature || "").trim();
      if (!signature || signature.length > 2000) throw new BadRequestException(`更新包签名无效：${key}`);
      return { target, arch, url: url.toString(), signature };
    });
  }

  private version(value: string, label: string): string {
    const normalized = String(value || "").trim().replace(/^v/, "");
    if (!parseDesktopVersion(normalized) || normalized.length > 32) throw new BadRequestException(`${label}必须遵循 SemVer，例如 1.2.3 或 1.2.3-beta.1`);
    return normalized;
  }

  private channel(value: string): string {
    const normalized = String(value || "stable").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(normalized)) throw new BadRequestException("发布渠道无效");
    return normalized;
  }

  private target(value: string): DesktopReleaseTarget {
    if (!DESKTOP_RELEASE_TARGETS.includes(value as DesktopReleaseTarget)) throw new BadRequestException("更新目标平台无效");
    return value as DesktopReleaseTarget;
  }

  private arch(value: string): DesktopReleaseArch {
    if (!DESKTOP_RELEASE_ARCHES.includes(value as DesktopReleaseArch)) throw new BadRequestException("更新包架构无效");
    return value as DesktopReleaseArch;
  }

  private inRollout(release: ReleaseRow, cohort: string): boolean {
    const percent = Number(release.rollout_percent);
    if (percent >= 100) return true;
    if (!cohort) return false;
    const bucket = createHash("sha256").update(`${release.id}:${cohort}`).digest().readUInt32BE(0) % 100;
    return bucket < percent;
  }

  private async get(id: string) {
    const release = await this.release(id);
    return this.present(release, await this.artifacts(id));
  }

  private async release(id: string): Promise<ReleaseRow> {
    const [release] = await this.database.query<ReleaseRow[]>(
      `SELECT id, version, channel, status, notes, min_supported_version, rollout_percent,
              created_at, updated_at, published_at
       FROM desktop_releases WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!release) throw new NotFoundException("客户端版本不存在");
    return release;
  }

  private artifacts(id: string) {
    return this.database.query<ArtifactRow[]>(
      "SELECT id, release_id, target, arch, url, signature FROM desktop_release_artifacts WHERE release_id = ? ORDER BY target, arch",
      [id],
    );
  }

  private present(release: ReleaseRow, artifacts: ArtifactRow[]) {
    return { ...release, rollout_percent: Number(release.rollout_percent), artifacts };
  }

  private async replaceArtifacts(connection: PoolConnection, releaseId: string, artifacts: DesktopReleaseArtifactInput[]) {
    for (const artifact of artifacts) {
      await connection.execute(
        `INSERT INTO desktop_release_artifacts (id, release_id, target, arch, url, signature)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), releaseId, artifact.target, artifact.arch, artifact.url, artifact.signature],
      );
    }
  }

  private isDuplicate(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY");
  }
}
