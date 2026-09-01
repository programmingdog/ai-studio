import "dotenv/config";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  adminOrigin: string;
  bindHost: string;
  clientOrigins: string[];
  trustProxy: string[];
  jwtSecret: string;
  jwtExpiresIn: string;
  credentialEncryptionKey: string;
  database: DatabaseConfig;
  mailApiTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadDatabaseConfig(): DatabaseConfig {
  return {
    host: required("DB_HOST"),
    port: positiveInteger("DB_PORT", 3306),
    database: required("DB_NAME"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    connectionLimit: positiveInteger("DB_CONNECTION_LIMIT", 10),
  };
}

export function loadAppConfig(): AppConfig {
  const jwtSecret = required("JWT_SECRET");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  const credentialEncryptionKey = required("CREDENTIAL_ENCRYPTION_KEY");
  if (credentialEncryptionKey.length < 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters");

  return {
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
    port: positiveInteger("PORT", 3101),
    bindHost: process.env.BIND_HOST?.trim() || "0.0.0.0",
    adminOrigin: process.env.ADMIN_ORIGIN?.trim() || "http://localhost:3200",
    clientOrigins: (process.env.CLIENT_ORIGINS || "http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
    trustProxy: (process.env.TRUST_PROXY || "").split(",").map((value) => value.trim()).filter(Boolean),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || "8h",
    credentialEncryptionKey,
    database: loadDatabaseConfig(),
    mailApiTimeoutMs: positiveInteger("MAIL_API_TIMEOUT_MS", 30000),
  };
}
