// Isolated UI QA server: aliases every application API import to local fixtures.
// No access tokens, live requests, mail or payment operations are used.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
const root = resolve(__dirname);
export default defineConfig({ root, plugins: [react(), { name: "isolated-referral-api", enforce: "pre", resolveId(source, importer) {
  if (source === "@/lib/api" || (source === "../services/platform" && importer?.replaceAll("\\", "/").endsWith("/ReferralPanel.tsx"))) return resolve(root, "mock-api.ts");
} }], server: { host: "127.0.0.1", port: 1432, strictPort: true, fs: { allow: [resolve(root, "../..")] } } });
