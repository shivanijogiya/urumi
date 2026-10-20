// Canary support (#23, H2). Two env-driven behaviours, both OFF unless configured:
//
//  - TRACK (`stable` | `canary`, set by the Helm chart): every response carries
//    `x-urumi-track: <track>`, so scripts/canary/verdict.py can tell which Deployment served each of
//    its samples.
//  - FAULT INJECTION, for the forced-bad-release demo ONLY: FAULT_INJECT_ERROR_RATE (0–1) of
//    authenticated `POST /mcp` tools/call requests fail with a 500, and FAULT_INJECT_LATENCY_MS
//    delays every such request. The chart sets these only on the canary Deployment, only when asked
//    (scripts/canary/run.sh deploy with FAULT_INJECT_*). An injected failure runs no tool, so it
//    writes no audit row: it simulates a broken release, not a failed upstream call.
import { makeError, MCP_PATH } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';

export const TRACK_HEADER = 'x-urumi-track';

export interface CanaryOptions {
  /** Value of x-urumi-track; null/undefined = no header. */
  track?: string | null;
  /** Share (0–1) of tools/call requests answered with an injected 500. Default 0. */
  faultErrorRate?: number;
  /** Delay added to every tools/call request. Default 0. */
  faultLatencyMs?: number;
  /** [0, 1) source for the error draw; tests inject a fixed sequence. */
  random?: () => number;
}

function isToolsCall(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'tools/call'
  );
}

/** Register before the routes. A no-op when nothing is configured. */
export function registerCanary(app: FastifyInstance, opts: CanaryOptions): void {
  const { track, faultErrorRate = 0, faultLatencyMs = 0, random = Math.random } = opts;

  if (track) {
    // On the raw response so it also reaches hijacked replies (the MCP endpoint writes its own).
    app.addHook('onRequest', async (_req, reply) => {
      reply.raw.setHeader(TRACK_HEADER, track);
    });
  }

  if (faultErrorRate <= 0 && faultLatencyMs <= 0) return;
  // preHandler: after the route's onRequest API-key check and after the body is parsed.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== MCP_PATH || !isToolsCall(req.body)) {
      return;
    }
    if (faultLatencyMs > 0) await new Promise((r) => setTimeout(r, faultLatencyMs));
    if (faultErrorRate > 0 && random() < faultErrorRate) {
      return reply
        .code(500)
        .send(makeError('INTERNAL', 'Injected fault (FAULT_INJECT_ERROR_RATE)'));
    }
  });
}
