// Tool listing for the dashboard (any session). Tools are aggregated through the registry, so these
// routes see exactly what callTool can route to. Descriptions are already sanitised.
import { ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { isListable, toApiTool, type ToolRegistry } from '../core/registry.js';
import { HttpError, notFound, parse } from '../http/errors.js';
import { UpstreamError } from '../mcp-client/upstream-client.js';
import { findUpstreamRow } from '../upstreams/repo.js';
import { UpstreamParamsSchema } from '../upstreams/routes.js';

export function registerToolRoutes(app: FastifyInstance, registry: ToolRegistry): void {
  app.get(ROUTES.listTools.path, { preHandler: requireSession }, async () => ({
    tools: (await registry.listTools()).map(toApiTool),
  }));

  // Disabled or down upstreams have no tools on offer: an empty list, without contacting them.
  app.get(ROUTES.listUpstreamTools.path, { preHandler: requireSession }, async (req) => {
    const { id } = parse(UpstreamParamsSchema, req.params);
    const row = await findUpstreamRow(app.pool, id);
    if (!row) throw notFound('Upstream');
    if (!isListable(row)) return { tools: [] };
    try {
      return { tools: (await registry.toolsFor(row)).map(toApiTool) };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      req.log.warn({ upstream: row.slug, reason: err.detail }, 'upstream tool list failed');
      throw new HttpError('UPSTREAM_UNREACHABLE', `Server '${row.slug}' is unreachable`);
    }
  });
}
