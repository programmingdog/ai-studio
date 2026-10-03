import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { diskStorage } from "multer";
import { RowDataPacket } from "mysql2/promise";
import { AuditService } from "../common/audit.service";
import { DatabaseService } from "../database/database.service";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maximumImageBytes = 10 * 1024 * 1024;
export const maximumTutorialVideoBytes = 500 * 1024 * 1024;
interface MediaRow extends RowDataPacket {
  id: string; storage_name: string; mime_type: string; media_type: "IMAGE" | "VIDEO";
  original_name: string; byte_size: number | string;
}
export interface TutorialUploadFile {
  path: string; filename: string; originalname: string; mimetype: string; size: number;
}

export function tutorialMediaDirectory(): string {
  return resolve(process.env.TUTORIAL_MEDIA_DIRECTORY?.trim() || join(tmpdir(), "ai-studio", "tutorial-media"));
}

export const tutorialUploadStorage = diskStorage({
  destination: (_request, _file, callback) => {
    const incoming = join(tutorialMediaDirectory(), ".incoming");
    void mkdir(incoming, { recursive: true, mode: 0o700 }).then(() => callback(null, incoming), error => callback(error as Error, incoming));
  },
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.upload`),
});

function detectedMedia(header: Buffer): { mime: string; type: "IMAGE" | "VIDEO"; extensions: string[]; extension: string } | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: "image/png", type: "IMAGE", extensions: [".png"], extension: ".png" };
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { mime: "image/jpeg", type: "IMAGE", extensions: [".jpg", ".jpeg"], extension: ".jpg" };
  if (header.length >= 12 && header.toString("ascii",0,4) === "RIFF" && header.toString("ascii",8,12) === "WEBP") return { mime: "image/webp", type: "IMAGE", extensions: [".webp"], extension: ".webp" };
  if (["GIF87a", "GIF89a"].includes(header.toString("ascii",0,6))) return { mime: "image/gif", type: "IMAGE", extensions: [".gif"], extension: ".gif" };
  if (header.length >= 16 && header.toString("ascii",4,8) === "ftyp") {
    const boxSize = header.readUInt32BE(0);
    const brands = header.subarray(8, Math.min(boxSize,header.length)).toString("ascii");
    if (boxSize >= 16 && /(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash)/.test(brands)) return { mime: "video/mp4", type: "VIDEO", extensions: [".mp4"], extension: ".mp4" };
  }
  if (header.length >= 12 && header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && header.includes(Buffer.from("webm"))) return { mime: "video/webm", type: "VIDEO", extensions: [".webm"], extension: ".webm" };
  return null;
}

export type ByteRange = { start: number; end: number };
export function parseTutorialRange(value: string | undefined, size: number): ByteRange | null | "UNSATISFIABLE" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "UNSATISFIABLE";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "UNSATISFIABLE";
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "UNSATISFIABLE";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

@Injectable()
export class TutorialMediaService {
  private readonly root = tutorialMediaDirectory();
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async upload(adminUserId: string, file: TutorialUploadFile | undefined) {
    if (!file) throw new BadRequestException("请选择教程图片或视频");
    const incoming = join(this.root, ".incoming", file.filename);
    if (!/^[a-f0-9-]{36}\.upload$/i.test(file.filename) || resolve(file.path) !== incoming) {
      throw new BadRequestException("上传文件路径无效");
    }
    let finalPath: string | undefined;
    let inserted = false;
    try {
      const handle = await open(incoming, "r");
      let actualSize: number;
      let detected: ReturnType<typeof detectedMedia>;
      try {
        const info = await handle.stat();
        if (!info.isFile() || !info.size || info.size !== file.size) throw new BadRequestException("上传文件长度不正确");
        actualSize = info.size;
        const header = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        detected = detectedMedia(header.subarray(0, bytesRead));
      } finally { await handle.close(); }
      if (!detected || !detected.extensions.includes(extname(file.originalname).toLowerCase())
        || ![detected.mime, "application/octet-stream", ...(detected.mime === "image/jpeg" ? ["image/jpg"] : [])].includes(file.mimetype)) {
        throw new BadRequestException("仅支持 PNG、JPEG、WebP、GIF 图片和 MP4、WebM 视频，文件扩展名和实际格式必须一致");
      }
      if (actualSize > (detected.type === "IMAGE" ? maximumImageBytes : maximumTutorialVideoBytes)) {
        throw new BadRequestException(detected.type === "IMAGE" ? "图片不能超过 10MB" : "视频不能超过 500MB");
      }
      const id = randomUUID();
      const storageName = `${id}${detected.extension}`;
      const originalName = file.originalname.replaceAll("\\", "/").split("/").pop()!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || `media${detected.extension}`;
      finalPath = join(this.root, storageName);
      await rename(incoming, finalPath);
      await this.database.execute(
        "INSERT INTO tutorial_media (id,storage_name,mime_type,media_type,original_name,byte_size,created_by) VALUES (?,?,?,?,?,?,?)",
        [id, storageName, detected.mime, detected.type, originalName, actualSize, adminUserId],
      );
      inserted = true;
      await this.audit.record({ adminUserId, action: "tutorial.media.upload", entityType: "tutorial_media", entityId: id, details: { mime_type: detected.mime, size: actualSize } });
      return { id, url: `/api/v1/tutorials/media/${id}`, mime_type: detected.mime, media_type: detected.type, original_name: originalName, size: actualSize };
    } catch (error) {
      await unlink(incoming).catch(() => undefined);
      // Retain an already registered file if auditing fails; never leave an existing media record pointing at a removed file.
      if (finalPath && !inserted) await unlink(finalPath).catch(() => undefined);
      throw error;
    }
  }

  async open(id: string) {
    if (!uuid.test(id)) throw new NotFoundException("教程媒体不存在");
    const rows = await this.database.query<MediaRow[]>("SELECT id,storage_name,mime_type,media_type,original_name,byte_size FROM tutorial_media WHERE id=? LIMIT 1", [id]);
    const row = rows[0];
    if (!row || !new RegExp(`^${id}\\.(?:png|jpg|webp|gif|mp4|webm)$`, "i").test(row.storage_name)) throw new NotFoundException("教程媒体不存在");
    try {
      const handle = await open(join(this.root, row.storage_name), "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== Number(row.byte_size)) throw new NotFoundException("教程媒体文件不可用");
        return { handle, size: info.size, mimeType: row.mime_type, mediaType: row.media_type };
      } catch (error) { await handle.close(); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundException("教程媒体文件不存在");
      throw error;
    }
  }
}
