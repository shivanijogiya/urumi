# Build context: repo root. docker build -f apps/woo-mcp/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
# Every workspace manifest is needed for `npm ci` to match the lockfile.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/woo-mcp apps/woo-mcp
RUN npm run build -w @urumi/woo-mcp

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/woo-mcp/dist/main.js dist/main.js
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
