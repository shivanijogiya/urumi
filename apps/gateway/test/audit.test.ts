// Audit log (#16, T3/C2) against a real Postgres and real fake MCP upstreams: one awaited
// audit_log row per callTool whatever the outcome, no arguments or results stored, a failed audit
// write logged but never hiding the result, and GET /api/audit (member scoping, admin filters,
// keyset pagination, limit bounds).
import { Writable } from 'node:stream';
import {
  AuditListResponseSchema,
  ErrorEnvelopeSchema,
  type AuditEntry,
  type Outcome,
} from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAudit } from '../src/audit/repo.js';
import { GatewayError, type CallRecord } from '../src/core/call-tool.js';
import { LOGGER_OPTIONS } from '../src/server.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import {
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamOptions,
} from './helpers/fake-upstream.js';

const CALL_MS = 300;
const SENTINEL = 'SENTINEL-arg-value-4f9a2c71';

let t: TestApp;
let admin: string;
let adminId: string;
let memberA: { id: string; cookie: string };
let memberB: { id: string; cookie: string };
let logs: string;
const fakes: FakeUpstream[] = [];

beforeEach(async () => {
  logs = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += String(chunk);
      cb();
    },
  });
  t = await setupApp({
    upstreamAllowedHosts: ['localhost'],
    mcpTimeouts: { callMs: CALL_MS },
    logger: { ...LOGGER_OPTIONS, level: 'info', stream },
  });
  admin = await t.login(ADMIN.email, ADMIN.password);
  const a = await t.createUser(admin, { email: 'a@example.com' });
  const b = await t.createUser(admin, { email: 'b@example.com' });
  memberA = { id: a.id, cookie: await t.login('a@example.com', a.tempPassword) };
  memberB = { id: b.id, cookie: await t.login('b@example.com', b.tempPassword) };
  const { rows } = await t.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    ADMIN.email,
  ]);
  adminId = rows[0]!.id;
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

async function fake(opts: FakeUpstreamOptions): Promise<FakeUpstream> {
  const f = await startFakeUpstream(opts);
  fakes.push(f);
  return f;
}

async function addUpstream(slug: string, opts: Partial<FakeUpstreamOptions> = {}): Promise<string> {
  const f = await fake({ identity: slug, ...opts });
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug, name: `Upstream ${slug}`, url: f.url },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { upstream: { id: string } }).upstream.id;
}

async function createKey(cookie: string): Promise<string> {
  const res = await t.request('POST', '/api/keys', { cookie, body: { name: 'cli' } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { key: { id: string } }).key.id;
}

interface AuditRow {
  id: string;
  user_id: string;
  api_key_id: string | null;
  source: string;
  server_slug: string;
  tool: string;
  started_at: Date;
  duration_ms: number;
  outcome: Outcome;
  error_code: string | null;
}

async function auditRows(): Promise<AuditRow[]> {
  return (await t.pool.query<AuditRow>('SELECT * FROM audit_log ORDER BY id')).rows;
}

/** Runs a call that must fail with `code`; returns the GatewayError. */
async function failing(p: Promise<unknown>, code: string): Promise<GatewayError> {
  const err = await p.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  expect((err as GatewayError).code).toBe(code);
  return err as GatewayError;
}

const chat = (userId: string, name: string, args: unknown = {}) =>
  t.app.tools.callTool(userId, name, args, { source: 'chat' });

describe('one audit row per callTool', () => {
  it('ok via an MCP key: every column, written before the call returns', async () => {
    await addUpstream('a');
    const keyId = await createKey(memberA.cookie);
    const before = Date.now();

    const result = await t.app.tools.callTool(
      memberA.id,
      'a__search',
      { q: 'x' },
      { source: 'mcp', apiKeyId: keyId },
    );

    expect(result.isError).toBeFalsy();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: memberA.id,
      api_key_id: keyId,
      source: 'mcp',
      server_slug: 'a',
      tool: 'search',
      outcome: 'ok',
      error_code: null,
    });
    expect(rows[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.started_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.started_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('chat calls have source chat and no api_key_id', async () => {
    await addUpstream('a');
    await chat(memberA.id, 'a__search');
    expect(await auditRows()).toMatchObject([{ source: 'chat', api_key_id: null }]);
  });

  it('upstream throws → error / UPSTREAM_ERROR', async () => {
    await addUpstream('boom', { callFails: 'throw' });
    await failing(chat(memberA.id, 'boom__search'), 'UPSTREAM_ERROR');
    expect(await auditRows()).toMatchObject([
      { server_slug: 'boom', tool: 'search', outcome: 'error', error_code: 'UPSTREAM_ERROR' },
    ]);
  });

  it('isError result → returned to the caller, audited as error / UPSTREAM_ERROR', async () => {
    await addUpstream('iserr', { callFails: 'isError' });
    const result = await chat(memberA.id, 'iserr__search');
    expect(result.isError).toBe(true);
    expect(await auditRows()).toMatchObject([
      { server_slug: 'iserr', tool: 'search', outcome: 'error', error_code: 'UPSTREAM_ERROR' },
    ]);
  });

  it('timeout → timeout / UPSTREAM_TIMEOUT, duration at least the timeout', async () => {
    await addUpstream('slow', { callDelayMs: 3000 });
    await failing(chat(memberA.id, 'slow__search'), 'UPSTREAM_TIMEOUT');
    const rows = await auditRows();
    expect(rows).toMatchObject([
      { server_slug: 'slow', tool: 'search', outcome: 'timeout', error_code: 'UPSTREAM_TIMEOUT' },
    ]);
    expect(rows[0]!.duration_ms).toBeGreaterThanOrEqual(CALL_MS - 5);
  });

  it('TOOL_NOT_FOUND → denied, with the parsed slug or "unknown" and the requested tool part', async () => {
    await addUpstream('a');
    await failing(chat(memberA.id, 'a__nope'), 'TOOL_NOT_FOUND');
    await failing(chat(memberA.id, 'zzz__search'), 'TOOL_NOT_FOUND');
    await failing(chat(memberA.id, 'search'), 'TOOL_NOT_FOUND');

    expect(await auditRows()).toMatchObject([
      { server_slug: 'a', tool: 'nope', outcome: 'denied', error_code: 'TOOL_NOT_FOUND' },
      { server_slug: 'zzz', tool: 'search', outcome: 'denied', error_code: 'TOOL_NOT_FOUND' },
      { server_slug: 'unknown', tool: 'search', outcome: 'denied', error_code: 'TOOL_NOT_FOUND' },
    ]);
  });

  it('UPSTREAM_DISABLED → denied', async () => {
    const id = await addUpstream('off');
    const res = await t.request('PATCH', `/api/upstreams/${id}`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(res.statusCode, res.body).toBe(200);

    await failing(chat(memberA.id, 'off__search'), 'UPSTREAM_DISABLED');
    expect(await auditRows()).toMatchObject([
      { server_slug: 'off', tool: 'search', outcome: 'denied', error_code: 'UPSTREAM_DISABLED' },
    ]);
  });
});

describe('no arguments or results stored', () => {
  it('has no column for arguments or results', async () => {
    const { rows } = await t.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'audit_log' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'api_key_id',
      'duration_ms',
      'error_code',
      'id',
      'outcome',
      'server_slug',
      'source',
      'started_at',
      'tool',
      'user_id',
    ]);
  });

  it('never writes an argument value into any column, whatever the outcome', async () => {
    await addUpstream('a');
    await addUpstream('boom', { callFails: 'throw' });
    await addUpstream('slow', { callDelayMs: 3000 });
    const args = { q: SENTINEL, nested: { deep: [SENTINEL] } };

    const ok = await chat(memberA.id, 'a__search', args);
    // The fake echoes its arguments: the result carries the sentinel, the audit row must not.
    expect(JSON.stringify(ok)).toContain(SENTINEL);
    await failing(chat(memberA.id, 'boom__search', args), 'UPSTREAM_ERROR');
    await failing(chat(memberA.id, 'slow__search', args), 'UPSTREAM_TIMEOUT');
    await failing(chat(memberA.id, 'a__nope', args), 'TOOL_NOT_FOUND');

    const { rows } = await t.pool.query<{ row: string }>(
      'SELECT row_to_json(a)::text AS row FROM audit_log a',
    );
    expect(rows).toHaveLength(4);
    for (const { row } of rows) expect(row).not.toContain(SENTINEL);
  });
});

describe('audit write failure', () => {
  it('still returns the result (and still throws the real error), logging each lost row', async () => {
    await addUpstream('a');
    // A real insert failure: the api_key_id foreign key points at no key.
    const ghostKey = '00000000-0000-4000-8000-000000000000';
    const mcp = { source: 'mcp' as const, apiKeyId: ghostKey };

    const result = await t.app.tools.callTool(memberA.id, 'a__search', { q: SENTINEL }, mcp);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain(SENTINEL);
    await failing(t.app.tools.callTool(memberA.id, 'a__nope', {}, mcp), 'TOOL_NOT_FOUND');

    expect(await auditRows()).toHaveLength(0);
    const errors = logs
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { level: number; msg: string; audit?: Partial<CallRecord> })
      .filter((l) => l.msg === 'audit write failed');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.level === 50)).toBe(true);
    expect(errors.map((e) => e.audit)).toMatchObject([
      { userId: memberA.id, serverSlug: 'a', tool: 'search', outcome: 'ok' },
      { userId: memberA.id, serverSlug: 'a', tool: 'nope', outcome: 'denied' },
    ]);
    // The log keeps the row, never the arguments.
    expect(logs).not.toContain(SENTINEL);
  });
});

describe('GET /api/audit', () => {
  const T0 = Date.parse('2026-10-01T00:00:00.000Z');

  function record(userId: string, minute: number, extra: Partial<CallRecord> = {}): CallRecord {
    return {
      userId,
      apiKeyId: null,
      source: 'chat',
      serverSlug: 'woo',
      tool: 'list_orders',
      startedAt: new Date(T0 + minute * 60_000),
      durationMs: 12,
      outcome: 'ok',
      errorCode: null,
      errorDetail: null,
      resolved: true,
      ...extra,
    };
  }

  async function seed(records: CallRecord[]): Promise<void> {
    for (const r of records) await insertAudit(t.pool, r);
  }

  async function list(cookie: string | undefined, query = ''): Promise<AuditEntry[]> {
    const res = await t.request('GET', `/api/audit${query}`, cookie ? { cookie } : {});
    expect(res.statusCode, res.body).toBe(200);
    return AuditListResponseSchema.parse(res.json()).items;
  }

  async function expectStatus(
    cookie: string | undefined,
    query: string,
    status: number,
    code: string,
  ) {
    const res = await t.request('GET', `/api/audit${query}`, cookie ? { cookie } : {});
    expect(res.statusCode, res.body).toBe(status);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe(code);
  }

  it('is 401 without a session', async () => {
    await expectStatus(undefined, '', 401, 'UNAUTHENTICATED');
  });

  it('members see only their own rows, even when asking for another user', async () => {
    await seed([record(memberA.id, 1), record(memberB.id, 2), record(adminId, 3)]);

    const own = await list(memberA.cookie);
    expect(own.map((e) => e.userId)).toEqual([memberA.id]);
    expect(await list(memberA.cookie, `?userId=${memberB.id}`)).toEqual(own);
    expect((await list(memberB.cookie)).map((e) => e.userId)).toEqual([memberB.id]);
  });

  it('admins see everyone, newest first, with the user email', async () => {
    await seed([record(memberA.id, 1), record(memberB.id, 2)]);
    const items = await list(admin);
    expect(items.map((e) => [e.userId, e.userEmail])).toEqual([
      [memberB.id, 'b@example.com'],
      [memberA.id, 'a@example.com'],
    ]);
    expect(items[1]).toEqual({
      id: expect.any(String),
      userId: memberA.id,
      userEmail: 'a@example.com',
      source: 'chat',
      serverSlug: 'woo',
      tool: 'list_orders',
      startedAt: new Date(T0 + 60_000).toISOString(),
      durationMs: 12,
      outcome: 'ok',
      errorCode: null,
    });
  });

  it('admin filters: userId, serverSlug, tool, outcome, from, to', async () => {
    await seed([
      record(memberA.id, 1),
      record(memberB.id, 2, { serverSlug: 'crm' }),
      record(memberA.id, 3, { tool: 'get_order' }),
      record(memberB.id, 4, { outcome: 'timeout', errorCode: 'UPSTREAM_TIMEOUT' }),
      record(memberA.id, 5, {
        outcome: 'denied',
        errorCode: 'TOOL_NOT_FOUND',
        serverSlug: 'unknown',
      }),
    ]);
    const minutes = (items: AuditEntry[]) =>
      items.map((e) => (Date.parse(e.startedAt) - T0) / 60_000);
    const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

    expect(minutes(await list(admin))).toEqual([5, 4, 3, 2, 1]);
    expect(minutes(await list(admin, `?userId=${memberB.id}`))).toEqual([4, 2]);
    expect(minutes(await list(admin, '?serverSlug=crm'))).toEqual([2]);
    expect(minutes(await list(admin, '?tool=get_order'))).toEqual([3]);
    expect(minutes(await list(admin, '?outcome=timeout'))).toEqual([4]);
    expect(minutes(await list(admin, `?from=${at(3)}`))).toEqual([5, 4, 3]);
    expect(minutes(await list(admin, `?to=${at(3)}`))).toEqual([2, 1]);
    expect(minutes(await list(admin, `?from=${at(2)}&to=${at(4)}&serverSlug=woo`))).toEqual([3]);
    // Members can filter too, within their own rows.
    expect(minutes(await list(memberA.cookie, '?outcome=denied'))).toEqual([5]);
  });

  it('paginates by (started_at desc, id desc): every row exactly once', async () => {
    // Ties on started_at must be broken by id, not skipped or repeated.
    const records = [1, 1, 1, 2, 3, 3, 4, 5, 5, 5, 6].map((m, i) =>
      record(i % 2 ? memberA.id : memberB.id, m),
    );
    await seed(records);

    const seen: AuditEntry[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await t.request('GET', `/api/audit${query}`, { cookie: admin });
      expect(res.statusCode, res.body).toBe(200);
      const body = AuditListResponseSchema.parse(res.json());
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items);
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(seen).toHaveLength(records.length);
    expect(new Set(seen.map((e) => e.id)).size).toBe(records.length);
    const keys = seen.map((e) => [Date.parse(e.startedAt), BigInt(e.id)] as const);
    for (let i = 1; i < keys.length; i++) {
      const [pt, pid] = keys[i - 1]!;
      const [ct, cid] = keys[i]!;
      expect(pt > ct || (pt === ct && pid > cid)).toBe(true);
    }
  });

  it('has no next cursor when the last page is exactly full', async () => {
    await seed([record(memberA.id, 1), record(memberA.id, 2)]);
    const res = await t.request('GET', '/api/audit?limit=2', { cookie: admin });
    expect(AuditListResponseSchema.parse(res.json())).toMatchObject({ nextCursor: null });
  });

  it('limit defaults to 50 and is bounded 1–200', async () => {
    await seed(Array.from({ length: 55 }, (_, i) => record(memberA.id, i)));
    const res = await t.request('GET', '/api/audit', { cookie: admin });
    const body = AuditListResponseSchema.parse(res.json());
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
    expect(await list(admin, '?limit=1')).toHaveLength(1);
    expect(await list(admin, '?limit=200')).toHaveLength(55);

    for (const q of ['?limit=0', '?limit=201', '?limit=abc', '?limit=1.5']) {
      await expectStatus(admin, q, 400, 'VALIDATION_FAILED');
    }
  });

  it('rejects bad cursors, bad filters and unknown parameters with VALIDATION_FAILED', async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const q of [
      '?cursor=not-a-cursor',
      `?cursor=${b64({ t: 'yesterday', id: '1' })}`,
      `?cursor=${b64({ t: '2026-10-01T00:00:00.000000Z', id: '1; DROP TABLE audit_log' })}`,
      `?cursor=${b64([1, 2])}`,
      '?outcome=maybe',
      '?userId=not-a-uuid',
      '?serverSlug=Bad_Slug',
      '?from=yesterday',
      '?args=1',
    ]) {
      await expectStatus(admin, q, 400, 'VALIDATION_FAILED');
    }
  });

  it('lists rows written by real calls', async () => {
    await addUpstream('a');
    await chat(memberA.id, 'a__search', { q: SENTINEL });
    const [entry] = await list(memberA.cookie);
    expect(entry).toMatchObject({
      userId: memberA.id,
      serverSlug: 'a',
      tool: 'search',
      outcome: 'ok',
    });
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);
  });
});
