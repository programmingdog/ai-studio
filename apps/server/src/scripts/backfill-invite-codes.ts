import "reflect-metadata";
import { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";
import { EnvironmentService } from "../config/environment.service";
import { SecretCryptoService } from "../common/secret-crypto.service";
import { ReferralsService } from "../referrals/referrals.service";

async function main() {
  const environment = new EnvironmentService();
  const database = new DatabaseService(environment);
  const referrals = new ReferralsService(database, new SecretCryptoService(environment), environment);
  let count = 0;
  try {
    for (;;) {
      const rows = await database.query<RowDataPacket[]>("SELECT id FROM users WHERE invite_code IS NULL ORDER BY id LIMIT 100");
      if (!rows.length) break;
      for (const row of rows) { await referrals.ensureInviteCode(String(row.id)); count++; }
    }
    process.stdout.write(`Invite codes initialized for ${count} existing users; existing codes and parent relationships unchanged.\n`);
  } finally { await database.onModuleDestroy(); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Invite code backfill failed"}\n`); process.exitCode = 1; });
