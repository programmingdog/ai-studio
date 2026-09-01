import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

const prompts = [
  { key: "prompt.video_storyboard.default", name: "视频分镜默认提示词", description: "从视频内容生成标准结构化分镜。", file: "video-storyboard-default.txt" },
  { key: "prompt.video_storyboard.detailed", name: "视频分镜详细提示词", description: "从视频内容生成细粒度结构化分镜。", file: "video-storyboard-detailed.txt" },
  { key: "prompt.character_image.default", name: "角色图片默认提示词", description: "客户端角色图片生成的默认模板。", file: "character-image-default.txt" },
] as const;

async function main(): Promise<void> {
  const connection = await createConnection({ ...loadDatabaseConfig(), charset: "utf8mb4", timezone: "Z" });
  const promptDirectory = join(__dirname, "../../../desktop/src/prompts");
  try {
    for (const prompt of prompts) {
      const template = (await readFile(join(promptDirectory, prompt.file), "utf8")).trim();
      const valueJson = JSON.stringify({ template, variables: [] });
      const checksum = createHash("sha256").update(valueJson).digest("hex");
      await connection.beginTransaction();
      try {
        const [setRows] = await connection.query<RowDataPacket[]>("SELECT id FROM config_sets WHERE config_key = ? LIMIT 1 FOR UPDATE", [prompt.key]);
        const setId = setRows.length ? String(setRows[0]!.id) : randomUUID();
        if (!setRows.length) {
          await connection.execute(
            "INSERT INTO config_sets (id, config_key, category, name, description) VALUES (?, ?, 'PROMPT', ?, ?)",
            [setId, prompt.key, prompt.name, prompt.description],
          );
        }
        const [currentRows] = await connection.query<RowDataPacket[]>(
          `SELECT cv.value_json FROM config_releases cr
           INNER JOIN config_versions cv ON cv.id = cr.config_version_id
           WHERE cv.config_set_id = ? AND cr.channel = 'stable' AND cr.status = 'ACTIVE' AND cv.status = 'PUBLISHED'
           ORDER BY cr.created_at DESC LIMIT 1 FOR UPDATE`,
          [setId],
        );
        const currentValue = currentRows[0]?.value_json;
        const current = typeof currentValue === "string" ? JSON.parse(currentValue) as { template?: string } : currentValue as { template?: string } | undefined;
        if (current?.template?.trim() === template) {
          await connection.commit();
          process.stdout.write(`skip ${prompt.key}\n`);
          continue;
        }
        const [versionRows] = await connection.query<RowDataPacket[]>("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM config_versions WHERE config_set_id = ?", [setId]);
        const version = Number(versionRows[0]?.next_version || 1);
        const versionId = randomUUID();
        await connection.execute("UPDATE config_versions SET status = 'ARCHIVED' WHERE config_set_id = ? AND status = 'PUBLISHED'", [setId]);
        await connection.execute(
          "UPDATE config_releases cr INNER JOIN config_versions cv ON cv.id = cr.config_version_id SET cr.status = 'RETIRED' WHERE cv.config_set_id = ? AND cr.status = 'ACTIVE'",
          [setId],
        );
        await connection.execute(
          `INSERT INTO config_versions
            (id, config_set_id, version, value_json, checksum, status, change_note, published_at)
           VALUES (?, ?, ?, ?, ?, 'PUBLISHED', '同步客户端当前提示词模板', CURRENT_TIMESTAMP(3))`,
          [versionId, setId, version, valueJson, checksum],
        );
        await connection.execute(
          `INSERT INTO config_releases
            (id, config_version_id, channel, min_client_version, rollout_percent, status)
           VALUES (?, ?, 'stable', '0.1.0', 100, 'ACTIVE')`,
          [randomUUID(), versionId],
        );
        await connection.commit();
        process.stdout.write(`publish ${prompt.key} v${version}\n`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`prompt sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
