// Multi-store (ADR 015) against a real Postgres, with the Kubernetes API faked at its boundary
// (FakeStoreKube, an in-memory object store): admin-only API, limits and slug rules, the
// provisioner's create -> MariaDB -> WordPress -> bootstrap -> woo-mcp -> registered -> ready path,
// failures, timeout and Retry, resuming after a gateway died mid-provision, delete (namespace first,
// then rules and rows; finished by a later tick or another replica), garbage collection, the lease,
// and the SSRF exception for exactly a store row's own woo-mcp host. No secret leaves the gateway.
import { Writable } from 'node:stream';
import { StoreListResponseSchema, StoreResponseSchema } from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lease } from '../src/core/leader.js';
import { KubeError } from '../src/hosted/kube.js';
import { UpstreamClient } from '../src/mcp-client/upstream-client.js';
import type { KubeItem, StoreKubeApi } from '../src/stores/kube.js';
import type { StoreKind, StoreObject } from '../src/stores/manifests.js';
import { StoreProvisioner, STORES_LEASE } from '../src/stores/provisioner.js';
import { credentialHeaders } from '../src/upstreams/decrypt-for-call.js';
import { findUpstreamRow } from '../src/upstreams/repo.js';
import type { LookupFn } from '../src/upstreams/ssrf.js';
import { LOGGER_OPTIONS } from '../src/server.js';
import { ADMIN, ENC_KEY, setupApp, type TestApp } from './helpers/app.js';
import { SETTINGS } from './helpers/store-settings.js';

const PASSWORD = 'generated-password-6f1d2c3b4a5e';
const SCRIPTS = { 'bootstrap.sh': '#!/usr/bin/env bash\necho hi\n' };

class FakeStoreKube implements StoreKubeApi {
  objects = new Map<string, StoreObject & { status?: KubeItem['status'] }>();
  status = new Map<string, KubeItem['status']>();
  calls: string[] = [];
  /** Throw this on the n-th write from now (1 = next). */
  failAt: { n: number; err: KubeError } | null = null;
  key = (kind: string, ns: string, name: string) => `${kind}/${ns}/${name}`;
  private write(op: string, obj: StoreObject) {
    this.calls.push(`${op} ${obj.kind}/${obj.metadata.name}`);
    if (this.failAt && --this.failAt.n <= 0) {
      const { err } = this.failAt;
      this.failAt = null;
      throw err;
    }
    const ns = obj.kind === 'Namespace' ? '' : obj.metadata.namespace!;
    if (obj.kind !== 'Namespace' && !this.objects.has(this.key('Namespace', '', ns))) {
      throw new KubeError(404, `Kubernetes API HTTP 404 NotFound: namespaces "${ns}" not found`);
    }
    return this.key(obj.kind, ns, obj.metadata.name);
  }
  async apply(obj: StoreObject) {
    const k = this.write('apply', obj);
    // Like the API server: apply never clears a deletionTimestamp.
    const dt = (this.objects.get(k)?.metadata as KubeItem['metadata'] | undefined)
      ?.deletionTimestamp;
    const next = structuredClone(obj);
    if (dt) (next.metadata as KubeItem['metadata']).deletionTimestamp = dt;
    this.objects.set(k, next);
  }
  async createIfAbsent(obj: StoreObject) {
    const k = this.write('create', obj);
    if (this.objects.has(k)) return false;
    this.objects.set(k, structuredClone(obj));
    return true;
  }
  private item(k: string): KubeItem | null {
    const o = this.objects.get(k);
    if (!o) return null;
    return { metadata: o.metadata as KubeItem['metadata'], status: this.status.get(k) ?? {} };
  }
  async get(kind: StoreKind | 'Pod', ns: string, name: string) {
    return this.item(this.key(kind, kind === 'Namespace' ? '' : ns, name));
  }
  async list(kind: StoreKind | 'Pod', ns: string, selector = '') {
    const want = selector
      .split(',')
      .filter(Boolean)
      .map((s) => s.split('='));
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(`${kind}/${ns}/`))
      .map((k) => this.item(k)!)
      .filter((i) => want.every(([l, v]) => i.metadata.labels?.[l!] === v));
  }
  async delete(kind: StoreKind, ns: string, name: string) {
    this.calls.push(`delete ${kind}/${name}`);
    if (kind === 'Namespace') {
      const n = this.objects.get(this.key('Namespace', '', name));
      if (n) (n.metadata as KubeItem['metadata']).deletionTimestamp = new Date().toISOString();
      return;
    }
    this.objects.delete(this.key(kind, ns, name));
  }
  async listNamespaces(selector: string) {
    return (await this.list('Namespace', '', selector)).filter(
      (n) => n.metadata.labels?.['urumi.io/store'] === 'true',
    );
  }
  /** The namespace controller finished: everything in it is gone. */
  finishNamespaceDeletion(ns: string) {
    for (const k of [...this.objects.keys()]) {
      if (k === this.key('Namespace', '', ns) || k.split('/')[1] === ns) this.objects.delete(k);
    }
  }
  setStatus(kind: string, ns: string, name: string, status: KubeItem['status']) {
    this.status.set(this.key(kind, ns, name), status);
  }
  has(kind: string, ns: string, name: string) {
    return this.objects.has(this.key(kind, ns, name));
  }
  names(ns: string) {
    return [...this.objects.keys()]
      .filter((k) => k.split('/')[1] === ns)
      .map((k) => `${k.split('/')[0]}/${k.split('/')[2]}`);
  }
}

let t: TestApp;
let kube: FakeStoreKube;
let admin: string;
let member: string;
let logs: string;
let clock: Date;

async function build(extra: Record<string, unknown> = {}, enabled = true) {
  logs = '';
  clock = new Date();
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += String(chunk);
      cb();
    },
  });
  kube = new FakeStoreKube();
  t = await setupApp(
    {
      logger: { ...LOGGER_OPTIONS, level: 'trace', stream },
      mcpTimeouts: { listMs: 500 },
      builtInStore: {
        name: 'Urumi Store',
        slug: 'woo',
        storefrontUrl: 'http://store.localtest.me',
      },
      ...(enabled
        ? {
            stores: {
              kube,
              settings: SETTINGS,
              maxStores: 2,
              scripts: SCRIPTS,
              now: () => clock,
              random: () => PASSWORD,
              ...extra,
            },
          }
        : {}),
    },
    { toolPermissions: 'seeded' },
  );
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'member@example.com' });
  member = await t.login('member@example.com', m.tempPassword);
}

const create = (body: Record<string, unknown> = {}, cookie = admin) =>
  t.request('POST', '/api/stores', {
    cookie,
    body: { slug: 'shop2', name: 'Shop Two', adminEmail: 'owner@example.com', ...body },
  });
const list = async () =>
  StoreListResponseSchema.parse((await t.request('GET', '/api/stores', { cookie: admin })).json());
const store = async () => (await list()).stores[0]!;
const tick = () => t.app.storeProvisioner!.tick();
const NS = 'store-shop2';

/** Drives the fake cluster to "everything up" one component at a time. */
const up = {
  mariadb: () => kube.setStatus('StatefulSet', NS, 'mariadb', { readyReplicas: 1 }),
  wordpress: () => kube.setStatus('Deployment', NS, 'wordpress', { availableReplicas: 1 }),
  job: (g = 1) => kube.setStatus('Job', NS, `bootstrap-g${g}`, { succeeded: 1 }),
  wooMcp: () => kube.setStatus('Deployment', NS, 'woo-mcp', { availableReplicas: 1 }),
};

beforeEach(() => build());
afterEach(async () => {
  expect(logs).not.toContain(PASSWORD);
  await t.close();
});

describe('stores API', () => {
  it('is admin-only', async () => {
    expect((await t.request('GET', '/api/stores', { cookie: member })).statusCode).toBe(403);
    expect((await create({}, member)).statusCode).toBe(403);
    expect((await t.request('GET', '/api/stores')).statusCode).toBe(401);
  });

  it('lists the built-in store, the limit and the domain', async () => {
    expect(await list()).toMatchObject({
      enabled: true,
      maxStores: 2,
      domainSuffix: 'store.localtest.me',
      builtIn: { slug: 'woo', storefrontUrl: 'http://store.localtest.me' },
      stores: [],
    });
  });

  it('creates: reserves the slug (disabled store upstream, sealed shared secret), grants member defaults, starts provisioning', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const { store: s } = StoreResponseSchema.parse(res.json());
    expect(s).toMatchObject({
      slug: 'shop2',
      namespace: NS,
      storefrontUrl: 'http://shop2.store.localtest.me',
      phase: 'provisioning',
      upstreamEnabled: false,
      generation: 1,
    });
    const row = (await findUpstreamRow(t.pool, s.id))!;
    expect(row).toMatchObject({
      slug: 'shop2',
      store: true,
      hosted: false,
      enabled: false,
      url: 'http://woo-mcp.store-shop2.svc.cluster.local/mcp',
      credential_type: 'header',
      credential_header_name: 'x-woo-mcp-secret',
    });
    const shared = credentialHeaders(row, ENC_KEY)['x-woo-mcp-secret']!;
    expect(shared.length).toBeGreaterThanOrEqual(40);
    expect(res.body).not.toContain(shared);
    expect((await t.request('GET', '/api/upstreams', { cookie: admin })).body).not.toContain(
      shared,
    );
    // Kicked at once: namespace, bindings, policies, workloads, generated Secrets, bootstrap Job.
    expect(kube.has('Namespace', '', NS)).toBe(true);
    expect(kube.names(NS).sort()).toEqual(
      [
        'ConfigMap/store-bootstrap-scripts',
        'Deployment/wordpress',
        'Ingress/storefront',
        'Job/bootstrap-g1',
        'LimitRange/store-limits',
        'NetworkPolicy/allow-dns',
        'NetworkPolicy/bootstrap',
        'NetworkPolicy/default-deny',
        'NetworkPolicy/mariadb',
        'NetworkPolicy/woo-mcp',
        'NetworkPolicy/wordpress',
        'PersistentVolumeClaim/wordpress-docroot',
        'ResourceQuota/store-quota',
        'RoleBinding/store-bootstrap',
        'RoleBinding/urumi-gateway',
        'Secret/store-admin',
        'Secret/store-db',
        'Secret/woo-mcp-shared',
        'Service/mariadb',
        'Service/woo-mcp',
        'Service/wordpress',
        'ServiceAccount/store-bootstrap',
        'StatefulSet/mariadb',
      ].sort(),
    );
    // The namespace and its gateway RoleBinding come first; woo-mcp waits for the bootstrap Job.
    expect(kube.calls.slice(0, 2)).toEqual([
      'apply Namespace/store-shop2',
      'create RoleBinding/urumi-gateway',
    ]);
    expect(kube.has('Deployment', NS, 'woo-mcp')).toBe(false);
    const sharedObj = kube.objects.get(`Secret/${NS}/woo-mcp-shared`) as unknown as {
      data: Record<string, string>;
    };
    expect(Buffer.from(sharedObj.data.WOO_MCP_SHARED_SECRET!, 'base64').toString()).toBe(shared);
    // Members get the built-in store's read-only defaults for this slug.
    const { rows } = await t.pool.query(
      `SELECT tool FROM tool_permissions WHERE role = 'member' AND server_slug = 'shop2' AND effect = 'allow' ORDER BY tool`,
    );
    expect(rows.map((r) => r.tool)).toEqual(['get_order', 'list_orders', 'list_products']);
  });

  it('rejects bad and reserved slugs, a taken slug, the limit, and when multi-store is off', async () => {
    for (const slug of [
      'woo',
      'gateway',
      'everything',
      'default',
      'Shop',
      'a',
      'shop_2',
      '9shop',
    ]) {
      const r = await create({ slug });
      expect(r.statusCode, slug).toBe(400);
    }
    expect((await create({ adminEmail: 'not-an-email' })).statusCode).toBe(400);
    expect((await create({ password: 'x' })).statusCode).toBe(400);
    const u = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug: 'taken', name: 'Taken', url: 'https://example.com/mcp' },
    });
    expect(u.statusCode).toBe(201);
    const taken = await create({ slug: 'taken' });
    expect(taken.statusCode).toBe(409);
    expect((await create({ slug: 'shop2' })).statusCode).toBe(201);
    expect((await create({ slug: 'shop3' })).statusCode).toBe(201);
    const over = await create({ slug: 'shop4' });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toBe('Store limit reached (2 of 2); delete a store first');
    expect(kube.has('Namespace', '', 'store-shop4')).toBe(false);
    await t.close();
    await build({}, false);
    expect(await list()).toMatchObject({ enabled: false, stores: [] });
    const off = await create();
    expect(off.statusCode).toBe(400);
    expect(off.json().error.message).toMatch(/not enabled/);
  });

  it('holds the limit under concurrent creates (advisory lock)', async () => {
    const res = await Promise.all(['sa', 'sb', 'sc', 'sd'].map((slug) => create({ slug })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 201, 400, 400]);
    expect((await list()).stores).toHaveLength(2);
  });

  it('the upstream routes refuse to edit or delete a store row', async () => {
    const id = (await create()).json().store.id;
    const patch = await t.request('PATCH', `/api/upstreams/${id}`, {
      cookie: admin,
      body: { enabled: true },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.message).toMatch(/store/);
    expect((await t.request('DELETE', `/api/upstreams/${id}`, { cookie: admin })).statusCode).toBe(
      409,
    );
  });
});

describe('provisioner', () => {
  it('provisioning steps -> woo-mcp after the Job -> registered -> ready', async () => {
    const id = (await create()).json().store.id;
    await tick();
    expect(await store()).toMatchObject({ phase: 'provisioning', reason: 'Starting MariaDB' });
    up.mariadb();
    await tick();
    expect((await store()).reason).toBe('Starting WordPress');
    up.wordpress();
    await tick();
    expect((await store()).reason).toBe('Installing WordPress and WooCommerce (bootstrap job)');
    expect(kube.has('Deployment', NS, 'woo-mcp')).toBe(false);
    up.job();
    await tick();
    expect(kube.has('Deployment', NS, 'woo-mcp')).toBe(true);
    expect((await store()).reason).toBe('Starting woo-mcp');
    up.wooMcp();
    await tick();
    // Registered (enabled) and checked at once; no such host from the test machine: down.
    const row = (await findUpstreamRow(t.pool, id))!;
    expect(row.enabled).toBe(true);
    expect(row.status).toBe('down');
    expect((await store()).reason).toMatch(/^Waiting for woo-mcp to answer MCP/);
    await t.pool.query(`UPDATE upstreams SET status = 'up', last_error = NULL WHERE id = $1`, [id]);
    await tick();
    expect(await store()).toMatchObject({ phase: 'ready', reason: null, upstreamEnabled: true });
    // Ready + unchanged spec: nothing is re-applied.
    kube.calls = [];
    await tick();
    expect(kube.calls.filter((c) => !c.startsWith('delete'))).toEqual([]);
  });

  it('never rewrites the generated passwords (create-once Secrets)', async () => {
    await create();
    const before = JSON.stringify(kube.objects.get(`Secret/${NS}/store-db`));
    await tick();
    await tick();
    expect(JSON.stringify(kube.objects.get(`Secret/${NS}/store-db`))).toBe(before);
    expect(kube.calls.filter((c) => c === 'apply Secret/store-db')).toEqual([]);
  });

  it('a failed bootstrap Job is Failed with the reason; nothing is applied until Retry', async () => {
    const id = (await create()).json().store.id;
    up.mariadb();
    up.wordpress();
    kube.setStatus('Job', NS, 'bootstrap-g1', {
      failed: 3,
      conditions: [
        {
          type: 'Failed',
          status: 'True',
          reason: 'BackoffLimitExceeded',
          message: 'Job has reached the specified backoff limit',
        },
      ],
    });
    await tick();
    expect(await store()).toMatchObject({
      phase: 'failed',
      reason: expect.stringMatching(/^Bootstrap job failed \(BackoffLimitExceeded/),
    });
    kube.calls = [];
    await tick();
    expect(kube.calls).toEqual([]);

    const retry = await t.request('POST', `/api/stores/${id}/retry`, { cookie: admin });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().store).toMatchObject({ phase: 'provisioning', generation: 2 });
    expect(kube.has('Job', NS, 'bootstrap-g2')).toBe(true);
    await tick();
    expect(kube.has('Job', NS, 'bootstrap-g1')).toBe(false); // old generation removed
    expect((await store()).reason).toBe('Installing WordPress and WooCommerce (bootstrap job)');
    up.job(2);
    await tick();
    const mcp = kube.objects.get(`Deployment/${NS}/woo-mcp`) as unknown as {
      spec: { template: { metadata: { annotations: Record<string, string> } } };
    };
    expect(mcp.spec.template.metadata.annotations['urumi.io/store-generation']).toBe('2');
    const again = await t.request('POST', `/api/stores/${id}/retry`, { cookie: admin });
    expect(again.statusCode).toBe(409);
  });

  it('ImagePullBackOff fails at once; a store stuck past the timeout fails with its step', async () => {
    await create();
    up.mariadb();
    kube.objects.set(`Pod/${NS}/wordpress-x`, {
      apiVersion: 'v1',
      kind: 'Deployment',
      metadata: {
        name: 'wordpress-x',
        namespace: NS,
        labels: { 'app.kubernetes.io/component': 'wordpress' },
      },
    });
    kube.setStatus('Pod', NS, 'wordpress-x', {
      containerStatuses: [
        { name: 'wordpress', state: { waiting: { reason: 'ImagePullBackOff' } } },
      ],
    });
    await tick();
    expect(await store()).toMatchObject({
      phase: 'failed',
      reason: 'wordpress: ImagePullBackOff: the image could not be pulled',
    });

    await t.close();
    await build();
    await create();
    up.mariadb();
    up.wordpress();
    clock = new Date(clock.getTime() + 11 * 60_000);
    await tick();
    expect(await store()).toMatchObject({
      phase: 'failed',
      reason: 'Timed out after 10 min: Installing WordPress and WooCommerce (bootstrap job)',
    });
  });

  it('a rejected write (admission policy / RBAC 403) is Failed with the API reason', async () => {
    expect((await create()).statusCode).toBe(201);
    kube.failAt = {
      n: 1,
      err: new KubeError(403, 'Kubernetes API HTTP 403 Forbidden: denied by store guard'),
    };
    await tick();
    expect(await store()).toMatchObject({
      phase: 'failed',
      reason: 'Kubernetes API HTTP 403 Forbidden: denied by store guard',
    });
  });

  it('resumes after the gateway died mid-provision (transient error, then another replica)', async () => {
    kube.failAt = { n: 6, err: new KubeError(0, 'Kubernetes API unreachable (ECONNRESET)') };
    expect((await create()).statusCode).toBe(201);
    expect(kube.has('StatefulSet', NS, 'mariadb')).toBe(false); // the kick stopped half-way
    // The "dead" replica held the lease; once it expires, another replica takes over.
    const dead = new Lease(t.pool, STORES_LEASE, 'pod-dead', 60_000);
    expect(await dead.tryAcquire()).toBe(true);
    const other = new StoreProvisioner({
      pool: t.pool,
      kube,
      registry: t.app.tools.registry,
      encKey: ENC_KEY,
      log: t.app.log,
      settings: SETTINGS,
      scripts: SCRIPTS,
      lease: new Lease(t.pool, STORES_LEASE, 'pod-new', 60_000),
      random: () => PASSWORD,
    });
    expect(await other.tick()).toBe(false); // not the leader yet
    await t.pool.query(
      `UPDATE gateway_leases SET expires_at = now() - interval '1 second' WHERE name = $1`,
      [STORES_LEASE],
    );
    expect(await other.tick()).toBe(true);
    expect(kube.has('StatefulSet', NS, 'mariadb')).toBe(true);
    expect(kube.has('Job', NS, 'bootstrap-g1')).toBe(true);
    expect((await store()).phase).toBe('provisioning');
    await other.stop();
  });
});

describe('delete', () => {
  it('disables the upstream at once, deletes the namespace, then the rules and rows', async () => {
    const id = (await create()).json().store.id;
    up.mariadb();
    up.wordpress();
    up.job();
    await tick();
    up.wooMcp();
    await tick();
    // A per-user rule for this store is removed too; other slugs' rules stay.
    const m = (await t.request('GET', '/api/users', { cookie: admin }))
      .json()
      .users.find((u: { email: string }) => u.email === 'member@example.com');
    await t.request('POST', '/api/permissions', {
      cookie: admin,
      body: { userId: m.id, serverSlug: 'shop2', tool: 'create_product', effect: 'allow' },
    });

    const res = await t.request('DELETE', `/api/stores/${id}`, { cookie: admin });
    expect(res.statusCode).toBe(202);
    expect(res.json().store).toMatchObject({ phase: 'deleting', upstreamEnabled: false });
    expect((await findUpstreamRow(t.pool, id))!.enabled).toBe(false);
    expect(kube.calls).toContain('delete Namespace/store-shop2');
    // The namespace controller is still deleting: the store stays visible as Deleting.
    await tick();
    expect(await store()).toMatchObject({
      phase: 'deleting',
      reason: 'Deleting the namespace (volumes included)',
    });
    kube.finishNamespaceDeletion(NS);
    await tick();
    expect((await list()).stores).toEqual([]);
    expect(await findUpstreamRow(t.pool, id)).toBeNull();
    const { rows } = await t.pool.query(
      `SELECT 1 FROM tool_permissions WHERE server_slug = 'shop2'`,
    );
    expect(rows).toEqual([]);
    const { rows: woo } = await t.pool.query(
      `SELECT 1 FROM tool_permissions WHERE server_slug = 'woo'`,
    );
    expect(woo.length).toBeGreaterThan(0);
    expect((await t.request('DELETE', `/api/stores/${id}`, { cookie: admin })).statusCode).toBe(
      404,
    );
  });

  it('a delete whose API call failed is finished by a later tick (gateway restart)', async () => {
    const id = (await create()).json().store.id;
    const realDelete = kube.delete.bind(kube);
    kube.delete = async () => {
      throw new KubeError(0, 'Kubernetes API timed out');
    };
    expect((await t.request('DELETE', `/api/stores/${id}`, { cookie: admin })).statusCode).toBe(
      202,
    );
    expect((await store()).phase).toBe('deleting');
    kube.delete = realDelete;
    // A fresh provisioner (the restarted gateway) picks the row up from Postgres.
    const restarted = new StoreProvisioner({
      pool: t.pool,
      kube,
      registry: t.app.tools.registry,
      encKey: ENC_KEY,
      log: t.app.log,
      settings: SETTINGS,
      scripts: SCRIPTS,
    });
    await restarted.tick();
    expect(kube.objects.get(`Namespace//${NS}`)?.metadata).toHaveProperty('deletionTimestamp');
    kube.finishNamespaceDeletion(NS);
    await restarted.tick();
    expect(await findUpstreamRow(t.pool, id)).toBeNull();
    // Re-creating the same slug works afterwards.
    expect((await create()).statusCode).toBe(201);
  });

  it('a new store with the slug of a namespace still terminating waits for it', async () => {
    const id = (await create()).json().store.id;
    await t.request('DELETE', `/api/stores/${id}`, { cookie: admin });
    await t.pool.query(`DELETE FROM upstreams WHERE id = $1`, [id]); // rows gone, namespace not yet
    expect((await create()).statusCode).toBe(201);
    await tick();
    expect(await store()).toMatchObject({
      phase: 'provisioning',
      reason: 'Waiting for an old namespace to finish deleting',
    });
  });

  it('garbage-collects a store namespace with no row', async () => {
    await create();
    await t.pool.query('DELETE FROM upstreams WHERE store'); // e.g. a restored database
    await tick();
    expect(kube.objects.get(`Namespace//${NS}`)?.metadata).toHaveProperty('deletionTimestamp');
  });
});

describe('SSRF: a store row reaches exactly its own woo-mcp host', () => {
  const lookup: LookupFn = async () => [{ address: '10.43.12.34', family: 4 }];
  const target = (over: Record<string, unknown>) => ({
    id: '00000000-0000-4000-8000-000000000001',
    url: 'http://woo-mcp.store-shop2.svc.cluster.local:1/mcp',
    credential_type: 'none' as const,
    credential_header_name: null,
    credential_ciphertext: null,
    credential_iv: null,
    credential_tag: null,
    slug: 'shop2',
    store: true,
    ...over,
  });
  const detail = (c: UpstreamClient, p: Record<string, unknown>) =>
    c.listTools(target(p), 1500).then(
      () => 'ok',
      (e: { detail?: string }) => e.detail,
    );
  const on = new UpstreamClient({ encKey: ENC_KEY, allowedHosts: [], lookup, storeHosts: true });
  const off = new UpstreamClient({ encKey: ENC_KEY, allowedHosts: [], lookup });

  it('passes the guard for its own host (then fails to connect from here)', async () => {
    expect(await detail(on, {})).not.toBe('Address not allowed');
  });
  it('blocks it for a non-store row, another slug, other private hosts, or with multi-store off', async () => {
    expect(await detail(on, { store: false })).toBe('Address not allowed');
    expect(await detail(on, { slug: 'shop3' })).toBe('Address not allowed');
    expect(await detail(on, { url: 'http://urumi-postgres.urumi.svc.cluster.local:5432/' })).toBe(
      'Address not allowed',
    );
    expect(await detail(on, { url: 'http://mariadb.store-shop2.svc.cluster.local:3306/' })).toBe(
      'Address not allowed',
    );
    expect(await detail(off, {})).toBe('Address not allowed');
  });
});
