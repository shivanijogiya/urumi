// Cookie-authenticated dashboard API for OAuth (ADR 013):
//   GET  /api/oauth/requests/:id   the consent screen's data; binds the pending request to the
//                                  signed-in user and issues a one-time consent token
//   POST /api/oauth/requests/:id   {approve, consentToken} → {redirectTo}: code or access_denied
//   GET  /api/connected-apps       members: own grants; admins: everyone's
//   DELETE /api/connected-apps/:id revoke a grant: its access and refresh tokens stop working now
// CSRF on the decision: the global guard (JSON body + Origin = PUBLIC_ORIGIN + SameSite=Lax
// cookie) plus the consent token, which only a page that read the request with this session has.
import {
  OAuthDecisionRequestSchema,
  OAUTH_TTL,
  OPAQUE_ID_RE,
  ROUTES,
  type OAuthRequestInfo,
} from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireSession } from '../auth/session.js';
import { withTransaction } from '../db/tx.js';
import { notFound, parse } from '../http/errors.js';
import { randomToken, sha256, sha256hex } from './crypto.js';
import { redirectHostOf, withParams } from './redirect.js';
import {
  bindAuthRequest,
  consumeAuthRequest,
  insertCode,
  insertGrant,
  listConnectedApps,
  revokeGrant,
} from './repo.js';

const RequestParamsSchema = z.object({ id: z.string().regex(OPAQUE_ID_RE) });
const GrantParamsSchema = z.object({ id: z.uuid() });

export function registerConsentRoutes(app: FastifyInstance, opts: { issuer: string }): void {
  const { pool } = app;
  const expired = () =>
    notFound('Authorization request (it may have expired; start again from your app)');

  app.get(ROUTES.getOAuthRequest.path, { preHandler: requireSession }, async (req, reply) => {
    const { id } = parse(RequestParamsSchema, req.params);
    const consentToken = randomToken();
    const r = await bindAuthRequest(
      pool,
      sha256hex(id),
      currentUser(req).id,
      sha256hex(consentToken),
    );
    if (!r) throw expired();
    reply.header('cache-control', 'no-store');
    const info: OAuthRequestInfo = {
      client: { id: r.clientId, name: r.clientName },
      redirectHost: redirectHostOf(r.redirectUri),
      redirectUri: r.redirectUri,
      scope: r.scope,
      consentToken,
    };
    return info;
  });

  app.post(ROUTES.decideOAuthRequest.path, { preHandler: requireSession }, async (req, reply) => {
    const { id } = parse(RequestParamsSchema, req.params);
    const { approve, consentToken } = parse(OAuthDecisionRequestSchema, req.body);
    const user = currentUser(req);
    const redirectTo = await withTransaction(pool, async (tx) => {
      const r = await consumeAuthRequest(tx, sha256hex(id), user.id, sha256hex(consentToken));
      if (!r) return null;
      if (!approve) {
        return withParams(r.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied access',
          state: r.state ?? undefined,
          iss: opts.issuer,
        });
      }
      const grantId = await insertGrant(tx, {
        clientId: r.clientId,
        userId: user.id,
        scope: r.scope,
        resource: r.resource,
      });
      const code = randomToken();
      await insertCode(tx, {
        hash: sha256(code),
        grantId,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        ttlSeconds: OAUTH_TTL.codeSeconds,
      });
      return withParams(r.redirectUri, { code, state: r.state ?? undefined, iss: opts.issuer });
    });
    if (!redirectTo) throw expired();
    req.log.info({ userId: user.id, approve }, 'oauth consent decided');
    reply.header('cache-control', 'no-store');
    return { redirectTo };
  });

  app.get(ROUTES.listConnectedApps.path, { preHandler: requireSession }, async (req) => {
    const user = currentUser(req);
    const apps = await listConnectedApps(pool, user.role === 'admin' ? null : user.id);
    return {
      apps: apps.map(({ redirectUris, ...a }) => ({
        ...a,
        redirectHosts: [...new Set(redirectUris.map(redirectHostOf))],
      })),
    };
  });

  // Another user's grant is 404 for members (ids are not confirmed to exist), like API keys.
  app.delete(ROUTES.revokeConnectedApp.path, { preHandler: requireSession }, async (req, reply) => {
    const { id } = parse(GrantParamsSchema, req.params);
    const user = currentUser(req);
    const isAdmin = user.role === 'admin';
    const ok = await revokeGrant(pool, id, isAdmin ? 'admin' : 'user', isAdmin ? null : user.id);
    if (!ok) throw notFound('Connected app');
    req.log.info({ userId: user.id, grantId: id }, 'oauth grant revoked');
    return reply.code(204).send();
  });
}
