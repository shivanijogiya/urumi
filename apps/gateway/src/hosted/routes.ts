// Hosted MCP servers API (ADR 014), admin only. Create stores the spec (env values sealed) plus a
// disabled upstream row that reserves the slug, then applies the Kubernetes objects at once; the
// reconciler registers (enables) the upstream when the pod is ready. Delete disables the upstream
// immediately (tools vanish), removes the objects and the rows. Env values are write-only: no
// response, log line or error contains them (the strict HostedServerSchema has no field for them).
import { randomUUID } from 'node:crypto';
import {
  CreateHostedServerRequestSchema,
  ROUTES,
  UpdateHostedServerRequestSchema,
} from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth/session.js';
import type { ToolRegistry } from '../core/registry.js';
import { withTransaction } from '../db/tx.js';
import { conflict, HttpError, notFound, parse } from '../http/errors.js';
import { insertUpstream, updateUpstream } from '../upstreams/repo.js';
import { checkImage } from './images.js';
import { hostedUrl } from './manifests.js';
import type { HostedReconciler } from './reconciler.js';
import {
  countHosted,
  findHosted,
  insertHosted,
  listHosted,
  markHostedAbsent,
  sealEnv,
  toHosted,
  updateHostedSpec,
  type HostedWithUpstream,
} from './repo.js';

const ParamsSchema = z.object({ id: z.uuid() });

export interface HostedRouteOptions {
  encKey: Buffer;
  registry: ToolRegistry;
  /** Null when hosting is off (no Kubernetes access): list works, writes are refused. */
  reconciler: HostedReconciler | null;
  namespace: string;
  allowedImages: readonly string[];
  requireDigest: boolean;
  maxServers: number;
}

const notEnabled = () =>
  new HttpError('VALIDATION_FAILED', 'Hosted MCP servers are not enabled on this gateway');

export function registerHostedRoutes(app: FastifyInstance, opts: HostedRouteOptions): void {
  const { pool } = app;
  const view = (row: HostedWithUpstream) =>
    toHosted(row, opts.registry.toolCount({ ...row.upstream, id: row.id }));

  /** Best effort: the reconciler retries on its next tick if the API call fails. */
  const applySoon = async (id: string) => {
    const row = await findHosted(pool, id);
    if (!row || !opts.reconciler) return;
    try {
      await opts.reconciler.applyNow(row);
    } catch (err) {
      app.log.warn(
        { hosted: row.upstream.slug, err: { message: (err as Error).message } },
        'hosted apply deferred to the reconciler',
      );
    }
  };

  app.get(ROUTES.listHostedServers.path, { preHandler: requireAdmin }, async () => ({
    enabled: opts.reconciler !== null,
    allowedImagePrefixes: opts.reconciler ? [...opts.allowedImages] : [],
    requireDigest: opts.requireDigest,
    maxServers: opts.maxServers,
    servers: (await listHosted(pool)).map(view),
  }));

  app.post(ROUTES.createHostedServer.path, { preHandler: requireAdmin }, async (req, reply) => {
    if (!opts.reconciler) throw notEnabled();
    const body = parse(CreateHostedServerRequestSchema, req.body);
    const image = checkImage(body.image, {
      allow: opts.allowedImages,
      requireDigest: opts.requireDigest,
    });
    const id = randomUUID();
    const env = sealEnv(opts.encKey, id, body.env);
    await withTransaction(pool, async (tx) => {
      // Serialise creates so the limit holds across replicas.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('hosted_servers_create'))`);
      if ((await countHosted(tx)) >= opts.maxServers) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `Hosted server limit reached (${opts.maxServers}); delete one first`,
        );
      }
      const upstream = await insertUpstream(tx, {
        id,
        slug: body.slug,
        name: body.name,
        url: hostedUrl(body.slug, opts.namespace, body.port, body.mcpPath),
        enabled: false, // registered (enabled) by the reconciler once the pod is ready
        credential: null,
        hosted: true,
      });
      if (!upstream) throw conflict('An upstream with this slug already exists');
      await insertHosted(tx, {
        id,
        image: image.name,
        imageDigest: image.digest,
        port: body.port,
        mcpPath: body.mcpPath,
        preset: body.preset,
        egress: body.egress,
        envKeys: env.keys,
        sealed: env.sealed,
        createdBy: currentUser(req).id,
      });
    });
    req.log.info(
      { hosted: body.slug, image: image.ref, egress: body.egress, preset: body.preset },
      'hosted server created',
    );
    await applySoon(id);
    const row = await findHosted(pool, id);
    return reply.code(201).send({ server: view(row!) });
  });

  app.patch(ROUTES.updateHostedServer.path, { preHandler: requireAdmin }, async (req) => {
    if (!opts.reconciler) throw notEnabled();
    const { id } = parse(ParamsSchema, req.params);
    const patch = parse(UpdateHostedServerRequestSchema, req.body);
    const image =
      patch.image === undefined
        ? undefined
        : checkImage(patch.image, { allow: opts.allowedImages, requireDigest: opts.requireDigest });
    await withTransaction(pool, async (tx) => {
      const current = await findHosted(tx, id, { forUpdate: true });
      if (!current || current.desired_state === 'absent') throw notFound('Hosted server');
      if (patch.name !== undefined) await updateUpstream(tx, id, { name: patch.name });
      const specChange =
        image !== undefined ||
        patch.preset !== undefined ||
        patch.egress !== undefined ||
        patch.env !== undefined;
      if (specChange) {
        await updateHostedSpec(tx, id, {
          ...(image ? { image: image.name, imageDigest: image.digest } : {}),
          ...(patch.preset ? { preset: patch.preset } : {}),
          ...(patch.egress !== undefined ? { egress: patch.egress } : {}),
          ...(patch.env !== undefined ? { env: sealEnv(opts.encKey, id, patch.env) } : {}),
        });
      }
    });
    await applySoon(id);
    const row = await findHosted(pool, id);
    if (!row) throw notFound('Hosted server');
    return { server: view(row) };
  });

  app.delete(ROUTES.deleteHostedServer.path, { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parse(ParamsSchema, req.params);
    const row = await findHosted(pool, id);
    if (!row || !(await markHostedAbsent(pool, id))) throw notFound('Hosted server');
    opts.registry.invalidate(id);
    if (opts.reconciler) {
      try {
        await opts.reconciler.deleteNow(id, row.upstream.slug);
      } catch (err) {
        req.log.warn(
          { hosted: row.upstream.slug, err: { message: (err as Error).message } },
          'hosted delete deferred to the reconciler',
        );
      }
    }
    req.log.info({ hosted: row.upstream.slug }, 'hosted server delete requested');
    return reply.code(204).send();
  });
}
