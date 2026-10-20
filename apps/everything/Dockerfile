# MCP reference server "everything" (upstream 2, the one D7 kills). Image only: no source here.
# Build context: repo root (scripts/build-images.sh), but nothing from it is copied.
#   docker build -f apps/everything/Dockerfile .
FROM node:22-alpine
ENV NODE_ENV=production
# Pinned. The package's `engines` says node >=24; checked on node 22 by
# tests/infra/upstreams.sh (initialize + tools/list through the gateway).
RUN npm install -g --no-audit --no-fund @modelcontextprotocol/server-everything@2.0.0 \
  && npm cache clean --force
USER node
WORKDIR /home/node
# The streamableHttp transport binds $PORT (default 3001) and serves POST/GET/DELETE /mcp.
ENV PORT=3001
EXPOSE 3001
# The server shuts down cleanly on SIGINT only. Node as PID 1 ignores a SIGTERM it has no handler
# for, so without this every pod stop would wait for the kill after the grace period.
STOPSIGNAL SIGINT
CMD ["mcp-server-everything", "streamableHttp"]
