import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const email = required("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const password = required("BOOTSTRAP_ADMIN_PASSWORD");
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "系统管理员";
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("BOOTSTRAP_ADMIN_EMAIL is invalid");
  if (password.length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters");

  const config = loadDatabaseConfig();
  const connection = await createConnection({ ...config, charset: "utf8mb4", timezone: "Z" });
  try {
    const [existing] = await connection.query<RowDataPacket[]>("SELECT id FROM admin_users WHERE email = ? LIMIT 1", [email]);
    if (existing.length) throw new Error("The bootstrap administrator already exists; no changes were made");
    const id = randomUUID();
    const passwordHash = await hash(password, 12);
    await connection.beginTransaction();
    try {
      await connection.execute(
        `INSERT INTO admin_users
          (id, email, password_hash, display_name, status, must_change_password, mfa_required)
         VALUES (?, ?, ?, ?, 'ACTIVE', 1, 1)`,
        [id, email, passwordHash, displayName],
      );
      await connection.execute(
        `INSERT INTO admin_user_roles (admin_user_id, role_id)
         VALUES (?, '00000000-0000-0000-0000-000000000001')`,
        [id],
      );
      await connection.commit();
      process.stdout.write(`bootstrap administrator created: ${email}\n`);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
