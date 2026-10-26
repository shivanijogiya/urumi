// CSRF guard for the cookie-authenticated API. SameSite=Lax already keeps the cookie off cross-site
// POSTs; this adds two cheap checks on every state-changing request (login included):
//   1. a request with a body must be application/json. Browsers cannot send that cross-origin
//      without a CORS preflight, which this API never grants (form posts are text/plain etc.).
//   2. if the browser sent an Origin header, it must be the dashboard's PUBLIC_ORIGIN.
// A missing Origin (curl, server-to-server) is allowed: such clients do not carry a victim's cookie.
//
// It applies to every unsafe method on every path, matched or not. The only exemptions are route
// patterns that authenticate with a bearer key instead of the cookie, compared against the route
// the router matched (req.routeOptions.url), never the raw URL: the router decodes %xx, so a raw
// prefix check could be sidestepped with /%61pi/... . Runs in onRequest, before body parsing.
import { OAUTH_PATHS } from '@urumi/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden } from './errors.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Routes that never read the session cookie, so CSRF does not apply: the external MCP endpoint
 * (bearer credential, src/mcp/endpoint.ts) and the OAuth endpoints that authenticate the client,
 * not the user (src/oauth/routes.ts; browser-based MCP clients call them cross-origin). The
 * consent decision is NOT exempt: it is a cookie route under /api.
 */
const EXEMPT_ROUTES = new Set<string>([
  '/mcp',
  OAUTH_PATHS.register,
  OAUTH_PATHS.token,
  OAUTH_PATHS.revoke,
]);

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
    if (!UNSAFE.has(req.method)) return;
    const route = req.routeOptions.url;
    if (route !== undefined && EXEMPT_ROUTES.has(route)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== publicOrigin) throw forbidden('Cross-origin request');
    if (hasBody(req) && !isJson(req)) throw forbidden('Content-Type must be application/json');
  });
}
