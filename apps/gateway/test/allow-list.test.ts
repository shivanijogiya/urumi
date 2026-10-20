// The SSRF allow-list as the chart renders it by default (release `urumi`, namespace `urumi`):
// the exact in-cluster upstream hosts and nothing else. Every in-cluster name resolves to a private
// IP, so anything not on the list is blocked, including the release's own Postgres, MariaDB and
// WordPress Services.
import { ErrorEnvelopeSchema } from '@urumi/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { LookupFn } from '../src/upstreams/ssrf.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';

const SVC = 'urumi.svc.cluster.local';
/** charts/platform/templates/gateway/deployment.yaml, UPSTREAM_ALLOWED_HOSTS default. */
const CHART_ALLOWED_HOSTS = [`urumi-woo-mcp.${SVC}`, `urumi-everything.${SVC}`];

const DNS: Record<string, string> = {
  [`urumi-woo-mcp.${SVC}`]: '10.43.0.20',
  [`urumi-everything.${SVC}`]: '10.43.0.21',
  [`urumi-postgres.${SVC}`]: '10.43.0.30',
  [`urumi-mariadb.${SVC}`]: '10.43.0.31',
  [`urumi-wordpress.${SVC}`]: '10.43.0.32',
  [`urumi-gateway.${SVC}`]: '10.43.0.33',
};
const lookup: LookupFn = async (host) => {
  const address = DNS[host];
  if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
};

let t: TestApp;
let admin: string;

beforeEach(async () => {
  t = await setupApp({ upstreamAllowedHosts: CHART_ALLOWED_HOSTS, lookup });
  admin = await t.login(ADMIN.email, ADMIN.password);
});
afterEach(async () => {
  await t.close();
});

const register = (slug: string, url: string) =>
  t.request('POST', '/api/upstreams', { cookie: admin, body: { slug, name: slug, url } });

it.each([
  ['woo', `http://urumi-woo-mcp.${SVC}/mcp`],
  ['everything', `http://urumi-everything.${SVC}/mcp`],
])('accepts the in-cluster upstream %s', async (slug, url) => {
  const res = await register(slug, url);
  expect(res.statusCode, res.body).toBe(201);
});

it.each([
  ['postgres', `http://urumi-postgres.${SVC}:5432`],
  ['mariadb', `http://urumi-mariadb.${SVC}:3306`],
  ['wordpress', `http://urumi-wordpress.${SVC}/wp-json/wc/v3/orders`],
  ['gateway', `http://urumi-gateway.${SVC}/api/users`],
])('rejects other in-cluster Services (%s) with SSRF_BLOCKED', async (slug, url) => {
  const res = await register(slug, url);
  expect(res.statusCode, res.body).toBe(400);
  expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe('SSRF_BLOCKED');
});
