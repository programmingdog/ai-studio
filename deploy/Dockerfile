# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS build-api
COPY tsconfig.base.json ./
COPY apps/server apps/server
RUN npm run build --workspace @aivs/server

FROM dependencies AS build-admin
COPY tsconfig.base.json ./
COPY apps/admin-web apps/admin-web
ENV NEXT_TELEMETRY_DISABLED=1
# Public, build-time value, not a secret. Same-origin Nginx avoids domain-specific images.
ENV NEXT_PUBLIC_API_BASE_URL=/api/v1
RUN npm run build --workspace @aivs/admin-web

FROM node:24-bookworm-slim AS api-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN npm ci --omit=dev --workspace @aivs/server --include-workspace-root=false --no-audit --no-fund

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app/apps/server
COPY --from=api-dependencies /app/node_modules /app/node_modules
COPY --from=build-api /app/apps/server/dist ./dist
# tsc does not copy SQL. Compiled migrate.js resolves this exact directory.
COPY apps/server/src/database/migrations ./dist/database/migrations
COPY apps/desktop/src/prompts /app/apps/desktop/src/prompts
COPY apps/desktop/src/data/visual-style-presets.json apps/desktop/src/data/creative-type-presets.json /app/apps/desktop/src/data/
COPY deploy/healthcheck.cjs /app/healthcheck.cjs
USER node
CMD ["node", "dist/main.js"]

FROM node:24-bookworm-slim AS admin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=127.0.0.1 PORT=3200
WORKDIR /app
COPY --from=build-admin --chown=node:node /app/apps/admin-web/.next/standalone ./
COPY --from=build-admin --chown=node:node /app/apps/admin-web/.next/static ./apps/admin-web/.next/static
COPY deploy/healthcheck.cjs /app/healthcheck.cjs
USER node
CMD ["node", "apps/admin-web/server.js"]
