import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

interface MigrationRow extends RowDataPacket {
  id: string;
  checksum: string;
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const connection = await createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: true,
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(191) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const migrationsDirectory = join(__dirname, "migrations");
    const filenames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    const [appliedRows] = await connection.query<MigrationRow[]>("SELECT id, checksum FROM schema_migrations");
    const applied = new Map(appliedRows.map((row) => [row.id, row.checksum]));

    for (const filename of filenames) {
      const sql = await readFile(join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existingChecksum = applied.get(filename);
      if (existingChecksum) {
        if (existingChecksum !== checksum) throw new Error(`Applied migration was modified: ${filename}`);
        process.stdout.write(`skip ${filename}\n`);
        continue;
      }

      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.execute("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", [filename, checksum]);
        await connection.commit();
        process.stdout.write(`apply ${filename}\n`);
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`migration failed: ${message}\n`);
  process.exitCode = 1;
});
