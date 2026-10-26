// Hosted MCP servers (ADR 014) against a real Postgres, with the Kubernetes API faked at its
// boundary (FakeKube, an in-memory object store): admin-only API, env values write-only and
// encrypted, the allow-list, the reconciler's create -> ready -> register -> delete cycle, its
// lease (one writer across replicas), garbage collection, and the SSRF exception for exactly the
// generated Service host of a hosted row.
import { Writable } from 'node:stream';
import { HostedServerListResponseSchema, HostedServerResponseSchema } from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lease } from '../src/core/leader.js';
import {
  KubeError,
  type DeploymentStatus,
  type KubeApi,
  type PodStatus,
} from '../src/hosted/kube.js';
import type { KubeObject } from '../src/hosted/manifests.js';
import { HOSTED_LEASE, HostedReconciler } from '../src/hosted/reconciler.js';
import { UpstreamClient } from '../src/mcp-client/upstream-client.js';
import { findUpstreamRow } from '../src/upstreams/repo.js';
import type { LookupFn } from '../src/upstreams/ssrf.js';
import { LOGGER_OPTIONS } from '../src/server.js';
import { ADMIN, ENC_KEY, setupApp, type TestApp } from './helpers/app.js';

const NS = 'urumi-hosted';
const IMAGE = 'k3d-urumi-registry.localhost:5005/urumi-everything:dev';
const ENV_SECRET = 'hosted-env-secret-value-7c1e9a';

class FakeKube implements KubeApi {
  objects = new Map<string, KubeObject>();
  ready = new Set<string>();
  waiting = new Map<string, string>();
  calls: string[] = [];
  failApply: KubeError | null = null;
  key = (kind: string, name: string) => `${kind}/${name}`;

  async apply(obj: KubeObject) {
    this.calls.push(`apply ${obj.kind}/${obj.metadata.name}`);
    if (obj.metadata.namespace !== NS) throw new Error('wrong namespace');
    if (this.failApply) throw this.failApply;
    this.objects.set(this.key(obj.kind, obj.metadata.name), structuredClone(obj));
  }
  async delete(kind: KubeObject['kind'], name: string) {
    this.calls.push(`delete ${kind}/${name}`);
    this.objects.delete(this.key(kind, name));
  }
  async getDeployment(name: string): Promise<DeploymentStatus | null> {
    const d = this.objects.get(this.key('Deployment', name));
    if (!d) return null;
    return {
      metadata: d.metadata,
      status: { availableReplicas: this.ready.has(name) ? 1 : 0 },
    };
  }
  async listDeployments(): Promise<DeploymentStatus[]> {
    return [...this.objects.values()]
      .filter((o) => o.kind === 'Deployment')
      .map((o) => ({ metadata: o.metadata }));
  }
  async listPods(selector: string): Promise<PodStatus[]> {
    const id = selector.split('=')[1];
    const dep = [...this.objects.values()].find(
      (o) => o.kind === 'Deployment' && o.metadata.labels['urumi.io/hosted-id'] === id,
    );
    if (!dep) return [];
    const reason = this.waiting.get(dep.metadata.name);
    return [
      {
        metadata: { name: `${dep.metadata.name}-pod` },
        status: {
          containerStatuses: [
            { name: 'mcp', state: reason ? { waiting: { reason } } : { running: {} } },
          ],
        },
      },
    ];
  }
}

let t: TestApp;
let kube: FakeKube;
let admin: string;
let member: string;
let logs: string;

async function build(extra: Record<string, unknown> = {}) {
  logs = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += String(chunk);
      cb();
    },
  });
  kube = new FakeKube();
  t = await setupApp({
    logger: { ...LOGGER_OPTIONS, level: 'trace', stream },
    mcpTimeouts: { listMs: 500 },
    hosted: {
      kube,
      namespace: NS,
      serviceAccountName: 'hosted-mcp',
      allowedImages: ['k3d-urumi-registry.localhost:5005/', 'docker.io/mcp/'],
      maxServers: 3,
      ...extra,
    },
  });
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'member@example.com' });
  member = await t.login('member@example.com', m.tempPassword);
}

const create = (body: Record<string, unknown>, cookie = admin) =>
  t.request('POST', '/api/hosted-servers', {
    cookie,
    body: { slug: 'demo', name: 'Demo', image: IMAGE, port: 3001, ...body },
  });
const list = async () =>
  HostedServerListResponseSchema.parse(
    (await t.request('GET', '/api/hosted-servers', { cookie: admin })).json(),
  );

beforeEach(() => build());
afterEach(async () => {
  expect(logs).not.toContain(ENV_SECRET);
  await t.close();
});

describe('hosted servers API', () => {
  it('is admin-only', async () => {
    expect((await t.request('GET', '/api/hosted-servers', { cookie: member })).statusCode).toBe(
      403,
    );
    expect((await create({}, member)).statusCode).toBe(403);
    expect((await t.request('GET', '/api/hosted-servers')).statusCode).toBe(401);
  });

  it('creates a disabled hosted upstream and applies Secret, Service and Deployment at once', async () => {
    const res = await create({ env: { API_TOKEN: ENV_SECRET }, egress: false });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(ENV_SECRET);
    const { server } = HostedServerResponseSchema.parse(res.json());
    expect(server).toMatchObject({
      slug: 'demo',
      image: IMAGE,
      imageDigest: null,
      envKeys: ['API_TOKEN'],
      phase: 'deploying',
      url: 'http://mcp-demo.urumi-hosted.svc.cluster.local:3001/mcp',
    });
    expect(kube.calls).toEqual([
      'apply Secret/mcp-demo-env',
      'apply Service/mcp-demo',
      'apply Deployment/mcp-demo',
    ]);
    const up = (await findUpstreamRow(t.pool, server.id))!;
    expect(up).toMatchObject({ hosted: true, enabled: false, slug: 'demo' });
    // Stored encrypted: no plaintext in the row.
    const { rows } = await t.pool.query('SELECT * FROM hosted_servers');
    expect(JSON.stringify(rows)).not.toContain(ENV_SECRET);
    expect(Buffer.from(rows[0].env_ciphertext).toString()).not.toContain(ENV_SECRET);
    // Never returned by any API: list, upstreams, tools.
    for (const path of ['/api/hosted-servers', '/api/upstreams', '/api/tools']) {
      const r = await t.request('GET', path, { cookie: admin });
      expect(r.body).not.toContain(ENV_SECRET);
    }
    const ups = (await t.request('GET', '/api/upstreams', { cookie: admin })).json();
    expect(ups.upstreams[0]).toMatchObject({ slug: 'demo', hosted: true, enabled: false });
  });

  it('rejects images off the allow-list, a taken slug, the limit, and when hosting is off', async () => {
    const bad = await create({ image: 'ghcr.io/evil/server:latest' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/not allowed.*allow-list/);
    expect(kube.calls).toEqual([]);

    expect((await create({})).statusCode).toBe(201);
    expect((await create({})).statusCode).toBe(409);
    await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug: 'remote', name: 'R', url: 'https://example.com/mcp' },
    });
    expect((await create({ slug: 'remote' })).statusCode).toBe(409);
    expect((await create({ slug: 'b' })).statusCode).toBe(201);
    expect((await create({ slug: 'c' })).statusCode).toBe(201);
    const over = await create({ slug: 'd' });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toMatch(/limit reached \(3\)/);

    await t.close();
    t = await setupApp({});
    admin = await t.login(ADMIN.email, ADMIN.password);
    expect((await list()).enabled).toBe(false);
    const off = await create({});
    expect(off.statusCode).toBe(400);
    expect(off.json().error.message).toMatch(/not enabled/);
    logs = '';
  });

  it('records a pinned digest', async () => {
    const digest = 'sha256:' + 'd'.repeat(64);
    const res = await create({
      image: `k3d-urumi-registry.localhost:5005/urumi-everything@${digest}`,
    });
    expect(res.json().server).toMatchObject({
      image: 'k3d-urumi-registry.localhost:5005/urumi-everything',
      imageDigest: digest,
    });
    const dep = kube.objects.get('Deployment/mcp-demo') as never as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(dep.spec.template.spec.containers[0].image).toBe(
      `k3d-urumi-registry.localhost:5005/urumi-everything@${digest}`,
    );
  });

  it('the upstream routes refuse to edit or delete a hosted row', async () => {
    const id = (await create({})).json().server.id;
    const patch = await t.request('PATCH', `/api/upstreams/${id}`, {
      cookie: admin,
      body: { enabled: true },
    });
    expect(patch.statusCode).toBe(409);
    expect((await t.request('DELETE', `/api/upstreams/${id}`, { cookie: admin })).statusCode).toBe(
      409,
    );
    expect((await findUpstreamRow(t.pool, id))!.enabled).toBe(false);
  });
});

describe('reconciler', () => {
  it('deploying -> ready -> upstream registered -> unreachable/connected; failure reasons', async () => {
    const id = (await create({})).json().server.id;
    const r = t.app.hostedReconciler!;
    await r.tick();
    expect((await list()).servers[0]).toMatchObject({ phase: 'deploying' });

    kube.waiting.set('mcp-demo', 'ImagePullBackOff');
    await r.tick();
    expect((await list()).servers[0]).toMatchObject({
      phase: 'failed',
      reason: expect.stringMatching(/^ImagePullBackOff/),
    });
    kube.waiting.delete('mcp-demo');

    kube.ready.add('mcp-demo');
    await r.tick();
    // Registered (enabled) and checked at once. No such host from the test machine: down.
    const up = (await findUpstreamRow(t.pool, id))!;
    expect(up.enabled).toBe(true);
    expect(up.status).toBe('down');
    expect((await list()).servers[0]).toMatchObject({ phase: 'unreachable' });

    await t.pool.query(`UPDATE upstreams SET status = 'up', last_error = NULL WHERE id = $1`, [id]);
    await r.tick();
    expect((await list()).servers[0]).toMatchObject({ phase: 'connected', reason: null });
  });

  it('a rejected apply (403 / Pod Security) is failed with the API reason', async () => {
    kube.failApply = new KubeError(403, 'Kubernetes API HTTP 403 Forbidden: violates PodSecurity');
    expect((await create({})).statusCode).toBe(201); // stored; apply deferred
    await t.app.hostedReconciler!.tick();
    expect((await list()).servers[0]).toMatchObject({
      phase: 'failed',
      reason: 'Kubernetes API HTTP 403 Forbidden: violates PodSecurity',
    });
  });

  it('re-applies after a spec change (PATCH env) and only then', async () => {
    const id = (await create({ env: { A: 'one' } })).json().server.id;
    const r = t.app.hostedReconciler!;
    kube.calls = [];
    await r.tick();
    expect(kube.calls.filter((c) => c.startsWith('apply'))).toEqual([]);
    const res = await t.request('PATCH', `/api/hosted-servers/${id}`, {
      cookie: admin,
      body: { env: { B: ENV_SECRET }, preset: 'medium' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().server).toMatchObject({ envKeys: ['B'], preset: 'medium' });
    expect(res.body).not.toContain(ENV_SECRET);
    const secret = kube.objects.get('Secret/mcp-demo-env') as never as {
      data: Record<string, string>;
    };
    expect(Object.keys(secret.data)).toEqual(['B']);
    // Remove all env: the Secret is deleted.
    await t.request('PATCH', `/api/hosted-servers/${id}`, { cookie: admin, body: { env: {} } });
    expect(kube.objects.has('Secret/mcp-demo-env')).toBe(false);
  });

  it('delete disables the upstream, removes all objects and the rows', async () => {
    const id = (await create({ env: { A: 'x' } })).json().server.id;
    kube.ready.add('mcp-demo');
    await t.app.hostedReconciler!.tick();
    const res = await t.request('DELETE', `/api/hosted-servers/${id}`, { cookie: admin });
    expect(res.statusCode).toBe(204);
    expect([...kube.objects.keys()]).toEqual([]);
    expect(await findUpstreamRow(t.pool, id)).toBeNull();
    expect((await list()).servers).toEqual([]);
    expect(
      (await t.request('DELETE', `/api/hosted-servers/${id}`, { cookie: admin })).statusCode,
    ).toBe(404);
  });

  it('a delete whose API call failed is finished by the next tick', async () => {
    const id = (await create({})).json().server.id;
    const realDelete = kube.delete.bind(kube);
    kube.delete = async () => {
      throw new KubeError(0, 'Kubernetes API timed out');
    };
    expect(
      (await t.request('DELETE', `/api/hosted-servers/${id}`, { cookie: admin })).statusCode,
    ).toBe(204);
    expect((await list()).servers[0]).toMatchObject({ phase: 'deleting' });
    expect((await findUpstreamRow(t.pool, id))!.enabled).toBe(false);
    kube.delete = realDelete;
    await t.app.hostedReconciler!.tick();
    expect(kube.objects.size).toBe(0);
    expect(await findUpstreamRow(t.pool, id)).toBeNull();
  });

  it('garbage-collects objects with no row', async () => {
    await create({});
    await t.pool.query('DELETE FROM upstreams'); // e.g. restored DB without the row
    await t.app.hostedReconciler!.tick();
    expect(kube.objects.size).toBe(0);
  });

  it('only the lease holder reconciles (several replicas)', async () => {
    await create({});
    const other = new Lease(t.pool, HOSTED_LEASE, 'pod-other', 60_000);
    expect(await other.tryAcquire()).toBe(true);
    const me = new HostedReconciler({
      pool: t.pool,
      kube,
      registry: t.app.tools.registry,
      encKey: ENC_KEY,
      log: t.app.log,
      namespace: NS,
      serviceAccountName: 'hosted-mcp',
      lease: new Lease(t.pool, HOSTED_LEASE, 'pod-me', 60_000),
    });
    kube.objects.clear(); // as if the create-time apply had not happened
    expect(await me.tick()).toBe(false);
    expect(kube.objects.size).toBe(0);
    await other.release();
    expect(await me.tick()).toBe(true);
    expect(kube.objects.has('Deployment/mcp-demo')).toBe(true);
    await me.stop();
  });
});

describe('SSRF: a hosted row reaches exactly its own Service host', () => {
  const lookup: LookupFn = async () => [{ address: '10.43.12.34', family: 4 }];
  const client = new UpstreamClient({
    encKey: ENC_KEY,
    allowedHosts: [],
    lookup,
    hostedNamespace: NS,
  });
  const target = (over: Record<string, unknown>) => ({
    id: '00000000-0000-4000-8000-000000000001',
    url: 'http://mcp-demo.urumi-hosted.svc.cluster.local:1/mcp',
    credential_type: 'none' as const,
    credential_header_name: null,
    credential_ciphertext: null,
    credential_iv: null,
    credential_tag: null,
    slug: 'demo',
    hosted: true,
    ...over,
  });
  const detail = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { detail?: string }) => e.detail,
    );

  it('passes the guard for its own host (then fails to connect from here)', async () => {
    expect(await detail(client.listTools(target({}), 1500))).not.toBe('Address not allowed');
  });
  it('blocks the same host for a non-hosted row, and other private hosts for a hosted row', async () => {
    expect(await detail(client.listTools(target({ hosted: false }), 1500))).toBe(
      'Address not allowed',
    );
    expect(
      await detail(
        client.listTools(
          target({ url: 'http://urumi-postgres.urumi.svc.cluster.local:5432/' }),
          1500,
        ),
      ),
    ).toBe('Address not allowed');
    expect(await detail(client.listTools(target({ slug: 'other' }), 1500))).toBe(
      'Address not allowed',
    );
  });
});
