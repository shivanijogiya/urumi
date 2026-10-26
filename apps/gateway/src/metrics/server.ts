// The internal metrics listener (ADR 011): its own Fastify instance on METRICS_PORT (default
// 9464), serving only GET /metrics. It is not the port the Service/Ingress route (8080), and a
// NetworkPolicy admits only pods labelled as metrics scrapers, so /metrics is never public.
import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayMetrics } from './metrics.js';

export async function startMetricsServer(
  metrics: GatewayMetrics,
  opts: { port: number; host?: string; log?: { error(obj: object, msg: string): void } },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_req, reply) => {
    try {
      const { contentType, body } = await metrics.render();
      return reply.type(contentType).send(body);
    } catch (err) {
      opts.log?.error({ err: { message: (err as Error).message } }, 'metrics render failed');
      return reply.code(500).type('text/plain').send('metrics unavailable\n');
    }
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('not found\n'));
  await app.listen({ host: opts.host ?? '0.0.0.0', port: opts.port });
  return app;
}
