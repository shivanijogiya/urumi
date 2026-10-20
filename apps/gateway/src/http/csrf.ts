// CSRF guard for the cookie-authenticated API. SameSite=Lax already keeps the cookie off cross-site
// POSTs; this adds two cheap checks on every state-changing /api request (login included):
//   1. a request with a body must be application/json. Browsers cannot send that cross-origin
//      without a CORS preflight, which this API never grants (form posts are text/plain etc.).
//   2. if the browser sent an Origin header, it must be the dashboard's PUBLIC_ORIGIN.
// A missing Origin (curl, server-to-server) is allowed: such clients do not carry a victim's cookie.
// Runs in onRequest, before the body is parsed. /mcp is not under /api and uses bearer keys.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden } from './errors.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(req: FastifyRequest): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function isJson(req: FastifyRequest): boolean {
  const type = req.headers['content-type'];
  return type?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export function registerCsrfGuard(app: FastifyInstance, publicOrigin: string): void {
  app.addHook('onRequest', async (req) => {
    if (!UNSAFE.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== publicOrigin) throw forbidden('Cross-origin request');
    if (hasBody(req) && !isJson(req)) throw forbidden('Content-Type must be application/json');
  });
}
