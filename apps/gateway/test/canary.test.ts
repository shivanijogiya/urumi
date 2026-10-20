// Canary support (#23, H2): the x-urumi-track response header (TRACK) and the fault injection used
// only for the forced-bad-release demo (FAULT_INJECT_ERROR_RATE, FAULT_INJECT_LATENCY_MS). Both are
// off unless configured. Unit tests use a bare Fastify app with a stand-in POST /mcp route; the
// wiring tests use the real buildApp on a real database.
import { MCP_PATH, ErrorEnvelopeSchema } from '@urumi/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCanary, TRACK_HEADER, type CanaryOptions } from '../src/http/canary.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';

const TOOLS_CALL = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'woo__list_orders', arguments: {} },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** registerCanary in front of a stand-in /mcp handler that counts the requests it receives. */
async function bare(opts: CanaryOptions): Promise<{ app: FastifyInstance; handled: () => number }> {
  const app = Fastify();
  apps.push(app);
  let handled = 0;
  registerCanary(app, opts);
  app.post(MCP_PATH, async () => {
    handled++;
    return { jsonrpc: '2.0', id: 1, result: {} };
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  await app.ready();
  return { app, handled: () => handled };
}

const post = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'POST', url: MCP_PATH, payload: body as object });

describe('x-urumi-track header', () => {
  it('is set on every response when a track is configured', async () => {
    const { app } = await bare({ track: 'canary' });
    expect((await post(app, TOOLS_CALL)).headers[TRACK_HEADER]).toBe('canary');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).headers[TRACK_HEADER]).toBe(
      'canary',
    );
    expect((await app.inject({ method: 'GET', url: '/nope' })).headers[TRACK_HEADER]).toBe(
      'canary',
    );
  });

  it('is absent when no track is configured', async () => {
    const { app } = await bare({});
    expect((await post(app, TOOLS_CALL)).headers[TRACK_HEADER]).toBeUndefined();
  });
});

describe('fault injection', () => {
  it('is off by default: every tools/call reaches the handler', async () => {
    const { app, handled } = await bare({});
    for (let i = 0; i < 20; i++) expect((await post(app, TOOLS_CALL)).statusCode).toBe(200);
    expect(handled()).toBe(20);
  });

  it('fails a tools/call with a 500 contracts envelope when the draw is below the rate', async () => {
    const draws = [0.4, 0.6];
    const { app, handled } = await bare({
      track: 'canary',
      faultErrorRate: 0.5,
      random: () => draws.shift()!,
    });
    const failed = await post(app, TOOLS_CALL);
    expect(failed.statusCode).toBe(500);
    expect(failed.headers[TRACK_HEADER]).toBe('canary');
    const env = ErrorEnvelopeSchema.parse(failed.json());
    expect(env.error.code).toBe('INTERNAL');
    expect(env.error.message).toMatch(/injected fault/i);
    expect(handled()).toBe(0);

    expect((await post(app, TOOLS_CALL)).statusCode).toBe(200);
    expect(handled()).toBe(1);
  });

  it('fails every tools/call at rate 1 but never other MCP methods or routes', async () => {
    const { app, handled } = await bare({ faultErrorRate: 1 });
    expect((await post(app, TOOLS_CALL)).statusCode).toBe(500);
    expect((await post(app, TOOLS_LIST)).statusCode).toBe(200);
    expect((await post(app, [TOOLS_CALL])).statusCode).toBe(200);
    expect((await post(app, 'not json')).statusCode).toBe(415);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect(handled()).toBe(2);
  });

  it('delays tools/call by the configured latency, and nothing else', async () => {
    const { app } = await bare({ faultLatencyMs: 120 });
    let start = Date.now();
    expect((await post(app, TOOLS_CALL)).statusCode).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    start = Date.now();
    await post(app, TOOLS_LIST);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('buildApp wiring', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  async function memberKey(app: TestApp): Promise<string> {
    const admin = await app.login(ADMIN.email, ADMIN.password);
    const m = await app.createUser(admin, { email: 'b@example.com' });
    const cookie = await app.login('b@example.com', m.tempPassword);
    const res = await app.request('POST', '/api/keys', { cookie, body: { name: 'canary' } });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { secret: string }).secret;
  }

  const mcp = (app: TestApp, key: string | null, body: unknown) =>
    app.request('POST', MCP_PATH, {
      body,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
    });

  it('serves the track header and injects faults only after the API key is checked', async () => {
    t = await setupApp({ track: 'canary', faultInject: { errorRate: 1, latencyMs: 0 } });
    const key = await memberKey(t);

    const unauth = await mcp(t, null, TOOLS_CALL);
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers[TRACK_HEADER]).toBe('canary');

    const res = await mcp(t, key, TOOLS_CALL);
    expect(res.statusCode).toBe(500);
    expect(res.headers[TRACK_HEADER]).toBe('canary');
    // No tool ran, so there is nothing to audit.
    const { rows } = await t.pool.query('SELECT 1 FROM audit_log');
    expect(rows).toHaveLength(0);
  });

  it('adds nothing by default', async () => {
    t = await setupApp();
    const key = await memberKey(t);
    const res = await mcp(t, key, TOOLS_CALL);
    // Unknown tool -> an isError tool result, not an injected 500.
    expect(res.statusCode).toBe(200);
    expect(res.headers[TRACK_HEADER]).toBeUndefined();
  });
});
