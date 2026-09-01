import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

interface SeedConfig {
  key: string;
  category: string;
  name: string;
  description: string;
  value: unknown;
}

interface CatalogPreset { id: string; category: string; name: string; description: string; prompt: string }

async function loadSeeds(): Promise<SeedConfig[]> {
  const desktop = join(__dirname, "../../../desktop/src");
  const [storyboard, detailedStoryboard, characterImage] = await Promise.all([
    readFile(join(desktop, "prompts/video-storyboard-default.txt"), "utf8"),
    readFile(join(desktop, "prompts/video-storyboard-detailed.txt"), "utf8"),
    readFile(join(desktop, "prompts/character-image-default.txt"), "utf8"),
  ]);
  return [
    {
      key: "prompt.video_storyboard.default",
      category: "PROMPT",
      name: "视频分镜默认提示词",
      description: "从视频内容生成标准结构化分镜。",
      value: { template: storyboard.trim(), variables: [] },
    },
    {
      key: "prompt.video_storyboard.detailed",
      category: "PROMPT",
      name: "视频分镜详细提示词",
      description: "从视频内容生成细粒度结构化分镜。",
      value: { template: detailedStoryboard.trim(), variables: [] },
    },
    {
      key: "prompt.character_image.default",
      category: "PROMPT",
      name: "角色图片默认提示词",
      description: "客户端角色图片生成的默认模板。",
      value: { template: characterImage.trim(), variables: [] },
    },
    {
      key: "pipeline.automatic.default",
      category: "PIPELINE",
      name: "一键全自动生成默认流程",
      description: "剧本或抖音链接输入后运行到本地成片的客户端默认流程。",
      value: {
        orchestration_owner: "CLIENT",
        stages: [
          { id: "content", enabled: true, retries: 2 },
          { id: "storyboard", enabled: true, retries: 2 },
          { id: "assets", enabled: true, retries: 3 },
          { id: "shot_videos", enabled: true, retries: 3 },
          { id: "download", enabled: true, retries: 5 },
          { id: "composition", enabled: true, retries: 2 },
        ],
        checkpoint_each_stage: true,
        continue_without_manual_confirmation: true,
        media_storage: "CLIENT_ONLY",
      },
    },
  ];
}

async function seedCatalog(
  connection: Awaited<ReturnType<typeof createConnection>>,
  categoryTable: "visual_style_categories" | "creative_type_categories",
  itemTable: "visual_styles" | "creative_types",
  presets: CatalogPreset[],
): Promise<void> {
  const categories = [...new Set(presets.map((item) => item.category))];
  const categoryCodes: Record<string, string> = itemTable === "visual_styles"
    ? { "电影": "movie", "短剧": "short-drama", "漫剧": "comic" }
    : { "电影": "movie", "电视剧": "tv-series", "科幻奇幻": "sci-fi-fantasy", "竖屏短剧": "vertical-short-drama", "漫剧": "comic" };
  const categoryIds = new Map<string, string>();
  for (const [index, name] of categories.entries()) {
    const code = categoryCodes[name] || `category-${index + 1}`;
    const [existing] = await connection.query<RowDataPacket[]>(`SELECT id FROM ${categoryTable} WHERE code = ? LIMIT 1`, [code]);
    const id = existing[0]?.id as string | undefined || randomUUID();
    if (!existing.length) {
      await connection.execute(
        `INSERT INTO ${categoryTable} (id, code, name, description, sort_order, status) VALUES (?, ?, ?, '', ?, 'ACTIVE')`,
        [id, code, name, (index + 1) * 10],
      );
    }
    categoryIds.set(name, id);
  }
  const categoryOffsets = new Map<string, number>();
  for (const preset of presets) {
    const categoryId = categoryIds.get(preset.category)!;
    const sortOrder = (categoryOffsets.get(preset.category) || 0) + 10;
    categoryOffsets.set(preset.category, sortOrder);
    await connection.execute(
      `INSERT IGNORE INTO ${itemTable} (id, category_id, code, name, description, prompt, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [randomUUID(), categoryId, preset.id, preset.name, preset.description, preset.prompt, sortOrder],
    );
  }
  process.stdout.write(`seed ${itemTable}: ${presets.length} items\n`);
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const connection = await createConnection({ ...config, charset: "utf8mb4", timezone: "Z" });
  try {
    for (const seed of await loadSeeds()) {
      const [existing] = await connection.query<RowDataPacket[]>("SELECT id FROM config_sets WHERE config_key = ? LIMIT 1", [seed.key]);
      if (existing.length) {
        process.stdout.write(`skip ${seed.key}\n`);
        continue;
      }
      const setId = randomUUID();
      const versionId = randomUUID();
      const releaseId = randomUUID();
      const valueJson = JSON.stringify(seed.value);
      const checksum = createHash("sha256").update(valueJson).digest("hex");
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO config_sets (id, config_key, category, name, description)
           VALUES (?, ?, ?, ?, ?)`,
          [setId, seed.key, seed.category, seed.name, seed.description],
        );
        await connection.execute(
          `INSERT INTO config_versions
            (id, config_set_id, version, value_json, checksum, status, change_note, published_at)
           VALUES (?, ?, 1, ?, ?, 'PUBLISHED', '从现有客户端复制的初始版本', CURRENT_TIMESTAMP(3))`,
          [versionId, setId, valueJson, checksum],
        );
        await connection.execute(
          `INSERT INTO config_releases
            (id, config_version_id, channel, min_client_version, rollout_percent, status)
           VALUES (?, ?, 'stable', '0.1.0', 100, 'ACTIVE')`,
          [releaseId, versionId],
        );
        await connection.commit();
        process.stdout.write(`seed ${seed.key}\n`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
    const desktop = join(__dirname, "../../../desktop/src/data");
    const [styles, creativeTypes] = await Promise.all([
      readFile(join(desktop, "visual-style-presets.json"), "utf8"),
      readFile(join(desktop, "creative-type-presets.json"), "utf8"),
    ]);
    await seedCatalog(connection, "visual_style_categories", "visual_styles", JSON.parse(styles) as CatalogPreset[]);
    await seedCatalog(connection, "creative_type_categories", "creative_types", JSON.parse(creativeTypes) as CatalogPreset[]);
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`config seed failed: ${message}\n`);
  process.exitCode = 1;
});
