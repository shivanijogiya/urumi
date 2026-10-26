// SQL for audit_log. One row per callTool; arguments and results have no column here by design
// (customer data). Parameterized queries only. Listing is keyset-paginated on
// (started_at desc, id desc) with an opaque base64url-JSON cursor.
import { classifyFailure, type AuditEntry, type ErrorCode, type Outcome } from '@urumi/contracts';
import type pg from 'pg';
import { z } from 'zod';
import type { CallRecord } from '../core/call-tool.js';
import { HttpError } from '../http/errors.js';

type Db = pg.Pool | pg.PoolClient;

export async function insertAudit(db: Db, r: CallRecord): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (user_id, api_key_id, source, server_slug, tool, started_at, duration_ms, outcome, error_code,
        error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      r.userId,
      r.apiKeyId,
      r.source,
      r.serverSlug,
      r.tool,
      r.startedAt,
      Math.max(0, Math.round(r.durationMs)),
      r.outcome,
      r.errorCode,
      r.errorDetail?.slice(0, 200) ?? null,
    ],
  );
}

/**
 * Position after the last row of a page. `t` is started_at with full microsecond precision (a JS
 * Date would drop it and skip or repeat rows); `id` is the bigint as a decimal string.
 */
interface AuditCursor {
  t: string;
  id: string;
}

const CursorSchema = z.strictObject({
  t: z.iso.datetime(),
  id: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/** VALIDATION_FAILED for anything that is not a cursor this module produced. */
export function decodeCursor(raw: string): AuditCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    value = undefined;
  }
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success) throw new HttpError('VALIDATION_FAILED', 'Invalid request: cursor');
  return parsed.data;
}

export interface AuditFilter {
  userId?: string | undefined;
  serverSlug?: string | undefined;
  tool?: string | undefined;
  outcome?: Outcome | undefined;
  /** Inclusive lower bound on started_at. */
  from?: string | undefined;
  /** Exclusive upper bound on started_at. */
  to?: string | undefined;
  limit: number;
  cursor?: AuditCursor | undefined;
}

interface AuditListRow {
  id: string;
  user_id: string;
  user_email: string;
  source: 'mcp' | 'chat';
  server_slug: string;
  tool: string;
  started_at: Date;
  started_key: string;
  duration_ms: number;
  outcome: Outcome;
  error_code: ErrorCode | null;
  error_detail: string | null;
}

function toEntry(row: AuditListRow): AuditEntry {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    source: row.source,
    serverSlug: row.server_slug,
    tool: row.tool,
    startedAt: row.started_at.toISOString(),
    durationMs: row.duration_ms,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    errorReason: classifyFailure(row.error_detail),
  };
}

/** Newest first. `nextCursor` is null when there is nothing after this page. */
export async function listAudit(
  db: Db,
  f: AuditFilter,
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (f.userId !== undefined) add((p) => `a.user_id = ${p}`, f.userId);
  if (f.serverSlug !== undefined) add((p) => `a.server_slug = ${p}`, f.serverSlug);
  if (f.tool !== undefined) add((p) => `a.tool = ${p}`, f.tool);
  if (f.outcome !== undefined) add((p) => `a.outcome = ${p}`, f.outcome);
  if (f.from !== undefined) add((p) => `a.started_at >= ${p}::timestamptz`, f.from);
  if (f.to !== undefined) add((p) => `a.started_at < ${p}::timestamptz`, f.to);
  if (f.cursor) {
    params.push(f.cursor.t, f.cursor.id);
    where.push(
      `(a.started_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`,
    );
  }
  params.push(f.limit + 1);

  const { rows } = await db.query<AuditListRow>(
    `SELECT a.id::text AS id, a.user_id, u.email AS user_email, a.source, a.server_slug, a.tool,
            a.started_at, a.duration_ms, a.outcome, a.error_code, a.error_detail,
            to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_key
     FROM audit_log a JOIN users u ON u.id = a.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.started_at DESC, a.id DESC
     LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > f.limit && last ? encodeCursor({ t: last.started_key, id: last.id }) : null;
  return { items: page.map(toEntry), nextCursor };
}
