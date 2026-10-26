// Stores API (ADR 015), admin only. Create reserves the slug with a disabled upstream row (its
// credential = a fresh woo-mcp shared secret, sealed like any upstream credential), grants members
// the built-in store's read-only tool defaults for that slug, and kicks the provisioner. Delete
// disables the upstream at once (tools vanish), then the provisioner removes the namespace and,
// once it is gone, the rules and rows. No password or secret is ever in a request or response.
import { randomUUID } from 'node:crypto';
import { CreateStoreRequestSchema, ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth/session.js';
import type { ToolRegistry } from '../core/registry.js';
import { encrypt } from '../crypto/secretbox.js';
import { withTransaction } from '../db/tx.js';
import { conflict, HttpError, notFound, parse } from '../http/errors.js';
import { insertUpstream } from '../upstreams/repo.js';
import { randomSecret, storefrontUrl } from './manifests.js';
import { SHARED_SECRET_HEADER, storeUpstreamUrl } from './names.js';
import type { StoreProvisioner } from './provisioner.js';
import {
  countStores,
  findStore,
  grantMemberDefaults,
  insertStore,
  listStores,
  markStoreAbsent,
  retryStore,
  toStore,
  type StoreWithUpstream,
} from './repo.js';

const ParamsSchema = z.object({ id: z.uuid() });

export interface StoreRouteOptions {
  encKey: Buffer;
  registry: ToolRegistry;
  /** Null when multi-store is off: list works (built-in store only), writes are refused. */
  provisioner: StoreProvisioner | null;
  maxStores: number;
  domainSuffix: string;
  scheme: 'http' | 'https';
  builtIn: { name: string; slug: string; storefrontUrl: string } | null;
}

const notEnabled = () =>
  new HttpError('VALIDATION_FAILED', 'Multiple stores are not enabled on this gateway');

export function registerStoreRoutes(app: FastifyInstance, opts: StoreRouteOptions): void {
  const { pool } = app;
  const view = (row: StoreWithUpstream) =>
    toStore(row, {
      storefrontUrl: storefrontUrl(row.upstream.slug, opts),
      toolCount: opts.registry.toolCount({ ...row.upstream, id: row.id }),
    });

  /** Best effort: the provisioner's next tick does the same if this fails. */
  const kick = async (id: string) => {
    const row = await findStore(pool, id);
    if (!row || !opts.provisioner) return;
    try {
      await opts.provisioner.kickNow(row);
    } catch (err) {
      app.log.warn(
        { store: row.upstream.slug, err: { message: (err as Error).message } },
        'store change deferred to the provisioner',
      );
    }
  };

  app.get(ROUTES.listStores.path, { preHandler: requireAdmin }, async () => ({
    enabled: opts.provisioner !== null,
    maxStores: opts.maxStores,
    domainSuffix: opts.domainSuffix,
    builtIn: opts.builtIn,
    stores: (await listStores(pool)).map(view),
  }));

  app.post(ROUTES.createStore.path, { preHandler: requireAdmin }, async (req, reply) => {
    if (!opts.provisioner) throw notEnabled();
    const body = parse(CreateStoreRequestSchema, req.body);
    const id = randomUUID();
    await withTransaction(pool, async (tx) => {
      // Serialise creates so the limit holds across replicas.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('stores_create'))`);
      const n = await countStores(tx);
      if (n >= opts.maxStores) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `Store limit reached (${n} of ${opts.maxStores}); delete a store first`,
        );
      }
      const upstream = await insertUpstream(tx, {
        id,
        slug: body.slug,
        name: body.name,
        url: storeUpstreamUrl(body.slug),
        enabled: false, // registered (enabled) by the provisioner once woo-mcp is ready
        credential: {
          type: 'header',
          headerName: SHARED_SECRET_HEADER,
          ...encrypt(opts.encKey, randomSecret(32), id),
        },
        store: true,
      });
      if (!upstream) throw conflict('An upstream or store with this slug already exists');
      await insertStore(tx, { id, adminEmail: body.adminEmail, createdBy: currentUser(req).id });
      await grantMemberDefaults(tx, body.slug);
    });
    req.log.info({ store: body.slug }, 'store created');
    await kick(id);
    const row = await findStore(pool, id);
    return reply.code(201).send({ store: view(row!) });
  });

  app.post(ROUTES.retryStore.path, { preHandler: requireAdmin }, async (req) => {
    if (!opts.provisioner) throw notEnabled();
    const { id } = parse(ParamsSchema, req.params);
    const row = await findStore(pool, id);
    if (!row || row.desired_state === 'absent') throw notFound('Store');
    if (!(await retryStore(pool, id))) throw conflict('Only a failed store can be retried');
    req.log.info({ store: row.upstream.slug }, 'store retry requested');
    await kick(id);
    return { store: view((await findStore(pool, id))!) };
  });

  app.delete(ROUTES.deleteStore.path, { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parse(ParamsSchema, req.params);
    const row = await findStore(pool, id);
    if (!row || !(await markStoreAbsent(pool, id))) throw notFound('Store');
    opts.registry.invalidate(id);
    req.log.info({ store: row.upstream.slug }, 'store delete requested');
    if (opts.provisioner) await kick(id);
    return reply.code(202).send({ store: view((await findStore(pool, id)) ?? row) });
  });
}
