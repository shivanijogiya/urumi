// SQL for upstreams. Parameterized queries only. Credential ciphertext stays in this module and
// decrypt-for-call.ts; API objects are built by toUpstream and checked against the strict schema.
import { classifyFailure, UpstreamSchema, type Upstream } from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type pg from 'pg';
import type { Sealed } from '../crypto/secretbox.js';

type Db = pg.Pool | pg.PoolClient;

/** A credential as stored: type and header name in the clear, the value sealed. */
export type StoredCredential = Sealed & { type: 'bearer' | 'header'; headerName: string | null };

const COLUMNS = `id, slug, name, url, enabled, credential_type, credential_header_name,
  credential_ciphertext, credential_iv, credential_tag, status, last_error, last_checked_at,
  last_ok_at, hosted, store, created_at, updated_at`;

/**
 * The API view of a row. Parsed with the strict UpstreamSchema, so an unexpected field (a
 * credential, say) throws and becomes a 500 instead of leaving the server.
 */
export function toUpstream(
  row: UpstreamRow,
  opts: { includeUrl: boolean; toolCount?: number },
): Upstream {
  return UpstreamSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    ...(opts.includeUrl ? { url: row.url } : {}),
    enabled: row.enabled,
    credentialType: row.credential_type,
    hasCredential: row.credential_type !== 'none',
    status: row.status,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastErrorReason: classifyFailure(row.last_error),
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    toolCount: opts.toolCount ?? 0, // from the tool registry cache
    hosted: row.hosted,
    store: row.store,
  });
}

export async function findUpstreamBySlug(db: Db, slug: string): Promise<UpstreamRow | null> {
  const { rows } = await db.query<UpstreamRow>(`SELECT ${COLUMNS} FROM upstreams WHERE slug = $1`, [
    slug,
  ]);
  return rows[0] ?? null;
}

/**
 * Stores a health result, only if the row still has the URL and credential that were checked and
 * is still enabled. False if the row changed (or is gone) in the meantime.
 */
export async function setUpstreamHealth(
  db: Db,
  checked: Pick<UpstreamRow, 'id' | 'url' | 'credential_iv'>,
  result: { status: 'up' | 'down'; lastError: string | null },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE upstreams SET status = $4, last_error = $5, last_checked_at = now(),
       last_ok_at = CASE WHEN $4 = 'up' THEN now() ELSE last_ok_at END
     WHERE id = $1 AND url = $2 AND credential_iv IS NOT DISTINCT FROM $3::bytea AND enabled`,
    [checked.id, checked.url, checked.credential_iv, result.status, result.lastError],
  );
  return (rowCount ?? 0) > 0;
}

export async function listUpstreamRows(db: Db): Promise<UpstreamRow[]> {
  const { rows } = await db.query<UpstreamRow>(`SELECT ${COLUMNS} FROM upstreams ORDER BY slug`);
  return rows;
}

/** `forUpdate` locks the row until the surrounding transaction ends. */
export async function findUpstreamRow(
  db: Db,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<UpstreamRow | null> {
  const { rows } = await db.query<UpstreamRow>(
    `SELECT ${COLUMNS} FROM upstreams WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Null when the slug is taken. The id is chosen by the caller (it is the credential's AAD). */
export async function insertUpstream(
  db: Db,
  u: {
    id: string;
    slug: string;
    name: string;
    url: string;
    enabled: boolean;
    credential: StoredCredential | null;
    /** A hosted server's row (ADR 014). Default false. */
    hosted?: boolean;
    /** A store's woo-mcp row (ADR 015). Default false. */
    store?: boolean;
  },
): Promise<UpstreamRow | null> {
  const c = u.credential;
  const { rows } = await db.query<UpstreamRow>(
    `INSERT INTO upstreams (id, slug, name, url, enabled, credential_type, credential_header_name,
       credential_ciphertext, credential_iv, credential_tag, hosted, store)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (slug) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      u.id,
      u.slug,
      u.name,
      u.url,
      u.enabled,
      c?.type ?? 'none',
      c?.headerName ?? null,
      c?.ciphertext ?? null,
      c?.iv ?? null,
      c?.tag ?? null,
      u.hosted ?? false,
      u.store ?? false,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Partial update. `credential`: undefined keeps it, null removes it (all columns), a value replaces
 * it. A new URL resets health to unknown: the old status described a different server.
 */
export async function updateUpstream(
  db: Db,
  id: string,
  patch: {
    name?: string;
    url?: string;
    enabled?: boolean;
    credential?: StoredCredential | null;
  },
): Promise<UpstreamRow | null> {
  const c = patch.credential;
  const setCredential = c !== undefined;
  const { rows } = await db.query<UpstreamRow>(
    `UPDATE upstreams AS u SET
       name = COALESCE($2, u.name),
       url = COALESCE($3, u.url),
       enabled = COALESCE($4, u.enabled),
       credential_type = CASE WHEN $5 THEN $6 ELSE u.credential_type END,
       credential_header_name = CASE WHEN $5 THEN $7 ELSE u.credential_header_name END,
       credential_ciphertext = CASE WHEN $5 THEN $8::bytea ELSE u.credential_ciphertext END,
       credential_iv = CASE WHEN $5 THEN $9::bytea ELSE u.credential_iv END,
       credential_tag = CASE WHEN $5 THEN $10::bytea ELSE u.credential_tag END,
       status = CASE WHEN $3 <> u.url THEN 'unknown' ELSE u.status END,
       last_error = CASE WHEN $3 <> u.url THEN NULL ELSE u.last_error END,
       last_checked_at = CASE WHEN $3 <> u.url THEN NULL ELSE u.last_checked_at END,
       updated_at = now()
     WHERE u.id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      patch.name ?? null,
      patch.url ?? null,
      patch.enabled ?? null,
      setCredential,
      c?.type ?? 'none',
      c?.headerName ?? null,
      c?.ciphertext ?? null,
      c?.iv ?? null,
      c?.tag ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteUpstream(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM upstreams WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
