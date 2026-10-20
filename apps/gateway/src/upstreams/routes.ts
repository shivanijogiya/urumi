// Upstream registry. Any session may list (url for admins only); admins add, edit, enable/disable
// and remove. Request bodies carry credentials: they are never logged (see LOGGER_OPTIONS redact)
// and never echoed; every response object passes the strict UpstreamSchema (toUpstream).
import { randomUUID } from 'node:crypto';
import {
  CreateUpstreamRequestSchema,
  ROUTES,
  UpdateUpstreamRequestSchema,
  type Credential,
} from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireSession } from '../auth/session.js';
import { encrypt } from '../crypto/secretbox.js';
import { conflict, notFound, parse } from '../http/errors.js';
import {
  deleteUpstream,
  insertUpstream,
  listUpstreamRows,
  toUpstream,
  updateUpstream,
  type StoredCredential,
} from './repo.js';
import { assertSafeUrl, type LookupFn } from './ssrf.js';

const UpstreamParamsSchema = z.object({ id: z.uuid() });

export interface UpstreamRouteOptions {
  /** GATEWAY_ENC_KEY. */
  encKey: Buffer;
  /** UPSTREAM_ALLOWED_HOSTS. */
  allowedHosts: readonly string[];
  /** DNS resolver for the SSRF guard; the system resolver if unset. */
  lookup?: LookupFn;
}

export function registerUpstreamRoutes(app: FastifyInstance, opts: UpstreamRouteOptions): void {
  const { pool } = app;
  const guard = (url: string) =>
    assertSafeUrl(url, { allow: opts.allowedHosts, lookup: opts.lookup });
  /** Sealed with the upstream id as AAD, so the ciphertext only opens on its own row. */
  const seal = (id: string, c: Credential): StoredCredential => ({
    type: c.type,
    headerName: c.type === 'header' ? c.headerName : null,
    ...encrypt(opts.encKey, c.value, id),
  });

  app.get(ROUTES.listUpstreams.path, { preHandler: requireSession }, async (req) => {
    const includeUrl = currentUser(req).role === 'admin';
    const rows = await listUpstreamRows(pool);
    return { upstreams: rows.map((r) => toUpstream(r, { includeUrl })) };
  });

  app.post(ROUTES.createUpstream.path, { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(CreateUpstreamRequestSchema, req.body);
    await guard(body.url);
    const id = randomUUID();
    const row = await insertUpstream(pool, {
      id,
      slug: body.slug,
      name: body.name,
      url: body.url,
      enabled: body.enabled,
      credential: body.credential ? seal(id, body.credential) : null,
    });
    if (!row) throw conflict('An upstream with this slug already exists');
    return reply.code(201).send({ upstream: toUpstream(row, { includeUrl: true }) });
  });

  // The schema is strict, so `slug` (immutable) is rejected as an unknown field.
  app.patch(ROUTES.updateUpstream.path, { preHandler: requireAdmin }, async (req) => {
    const { id } = parse(UpstreamParamsSchema, req.params);
    const patch = parse(UpdateUpstreamRequestSchema, req.body);
    if (patch.url !== undefined) await guard(patch.url);
    const { credential, ...rest } = patch;
    const row = await updateUpstream(pool, id, {
      ...rest,
      ...(credential === undefined ? {} : { credential: credential && seal(id, credential) }),
    });
    if (!row) throw notFound('Upstream');
    return { upstream: toUpstream(row, { includeUrl: true }) };
  });

  app.delete(ROUTES.deleteUpstream.path, { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parse(UpstreamParamsSchema, req.params);
    if (!(await deleteUpstream(pool, id))) throw notFound('Upstream');
    return reply.code(204).send();
  });
}
