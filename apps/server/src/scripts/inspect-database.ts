import "dotenv/config";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

interface DatabaseInfoRow extends RowDataPacket {
  version: string;
  database_name: string;
}

interface CountRow extends RowDataPacket {
  table_count: number | string;
  migration_count?: number | string;
  published_config_count?: number | string;
  media_blob_column_count?: number | string;
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const connection = await createConnection({ ...config, charset: "utf8mb4", timezone: "Z" });
  try {
    const [infoRows] = await connection.query<DatabaseInfoRow[]>("SELECT VERSION() AS version, DATABASE() AS database_name");
    const [countRows] = await connection.query<CountRow[]>(
      `SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()`,
    );
    const [migrationRows] = await connection.query<CountRow[]>(
      `SELECT IF(
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'),
        (SELECT COUNT(*) FROM schema_migrations), 0
      ) AS migration_count`,
    );
    const [configRows] = await connection.query<CountRow[]>(
      `SELECT IF(
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'config_versions'),
        (SELECT COUNT(*) FROM config_versions WHERE status = 'PUBLISHED'), 0
      ) AS published_config_count`,
    );
    const [blobRows] = await connection.query<CountRow[]>(
      `SELECT COUNT(*) AS media_blob_column_count
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND data_type IN ('tinyblob', 'blob', 'mediumblob', 'longblob')`,
    );
    const info = infoRows[0];
    process.stdout.write(JSON.stringify({
      connected: true,
      version: info?.version || "unknown",
      database: info?.database_name || "unknown",
      table_count: Number(countRows[0]?.table_count || 0),
      migration_count: Number(migrationRows[0]?.migration_count || 0),
      published_config_count: Number(configRows[0]?.published_config_count || 0),
      media_blob_column_count: Number(blobRows[0]?.media_blob_column_count || 0),
    }, null, 2) + "\n");
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`database inspection failed: ${message}\n`);
  process.exitCode = 1;
});
