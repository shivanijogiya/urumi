# Gateway image. Build context = repo root:
#   docker build -f apps/gateway/Dockerfile -t urumi-gateway .
FROM node:22-alpine AS build
WORKDIR /src
# Manifests first so the npm ci layer is cached until dependencies change. npm ci needs every
# workspace manifest the lockfile lists.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @urumi/gateway --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/gateway apps/gateway
RUN npm run build -w @urumi/gateway

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
COPY --from=build /src/apps/gateway/dist/main.js ./main.js
COPY packages/contracts/sql/*.sql ./migrations/
USER node
EXPOSE 8080
CMD ["node", "/app/main.js"]
