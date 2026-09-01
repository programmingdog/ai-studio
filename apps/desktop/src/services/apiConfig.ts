const DEVELOPMENT_API_BASE_URL = "http://localhost:3101/api/v1";
const PRODUCTION_API_BASE_URL = "https://ai-studio.yuntianxing.net/api/v1";

const configuredApiBaseUrl = import.meta.env.VITE_PLATFORM_API_URL?.trim();

export const platformApiBaseUrl = (
  configuredApiBaseUrl
  || (import.meta.env.PROD ? PRODUCTION_API_BASE_URL : DEVELOPMENT_API_BASE_URL)
).replace(/\/+$/, "");

export const platformApiEnvironment = import.meta.env.PROD ? "production" : "development";
