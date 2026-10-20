# Dashboard image: static Vite build served by unprivileged nginx on :8080.
# Build context = repo root:
#   docker build -f apps/dashboard/Dockerfile -t urumi-dashboard .
FROM node:22-alpine AS build
WORKDIR /src
# Manifests first so the npm ci layer is cached until dependencies change. npm ci needs every
# workspace manifest the lockfile lists.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @urumi/dashboard --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/dashboard apps/dashboard
RUN npm run build -w @urumi/dashboard

# Runs as uid 101 and writes only to /tmp (see nginx.conf), so it works with a read-only root fs.
FROM nginxinc/nginx-unprivileged:alpine
COPY apps/dashboard/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /src/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
