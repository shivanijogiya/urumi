// SQL for stores (ADR 015). Parameterized queries only. A store row is 1:1 with the upstream row
// that carries its slug, URL and sealed woo-mcp shared secret. No password is stored here.
import { StoreSchema, type Store } from '@urumi/contracts';
import type { StoreRow, UpstreamRow } from '@urumi/contracts/db';
import type pg from 'pg';
import { storeNamespace } from './names.js';

type Db = pg.Pool | pg.PoolClient;

/** Read-only tool rules every new store gets for members (the built-in store's, ADR 008). */
export const MEMBER_DEFAULT_TOOLS = ['list_products', 'list_orders', 'get_order'] as const;

export type StoreWithUpstream = StoreRow & {
  upstream: Pick<
    UpstreamRow,
    | 'id'
    | 'slug'
    | 'name'
    | 'url'
    | 'enabled'
    | 'status'
    | 'last_error'
    | 'credential_type'
    | 'credential_header_name'
    | 'credential_ciphertext'
    | 'credential_iv'
    | 'credential_tag'
    | 'updated_at'
  >;
};

const S = `s.id, s.admin_email, s.desired_state, s.phase, s.reason, s.generation,
  s.provision_started_at, s.created_by, s.created_at, s.updated_at, s.last_reconciled_at`;
const U = `u.slug AS u_slug, u.name AS u_name, u.url AS u_url, u.enabled AS u_enabled,
  u.status AS u_status, u.last_error AS u_last_error, u.credential_type AS u_credential_type,
  u.credential_header_name AS u_credential_header_name,
  u.credential_ciphertext AS u_credential_ciphertext, u.credential_iv AS u_credential_iv,
  u.credential_tag AS u_credential_tag, u.updated_at AS u_updated_at`;

type JoinedRow = StoreRow & {
  u_slug: string;
  u_name: string;
  u_url: string;
  u_enabled: boolean;
  u_status: UpstreamRow['status'];
  u_last_error: string | null;
  u_credential_type: UpstreamRow['credential_type'];
  u_credential_header_name: string | null;
  u_credential_ciphertext: Uint8Array | null;
  u_credential_iv: Uint8Array | null;
  u_credential_tag: Uint8Array | null;
  u_updated_at: Date;
};

function split(r: JoinedRow): StoreWithUpstream {
  const {
    u_slug,
    u_name,
    u_url,
    u_enabled,
    u_status,
    u_last_error,
    u_credential_type,
    u_credential_header_name,
    u_credential_ciphertext,
    u_credential_iv,
    u_credential_tag,
    u_updated_at,
    ...s
  } = r;
  return {
    ...s,
    upstream: {
      id: s.id,
      slug: u_slug,
      name: u_name,
      url: u_url,
      enabled: u_enabled,
      status: u_status,
      last_error: u_last_error,
      credential_type: u_credential_type,
      credential_header_name: u_credential_header_name,
      credential_ciphertext: u_credential_ciphertext,
      credential_iv: u_credential_iv,
      credential_tag: u_credential_tag,
      updated_at: u_updated_at,
    },
  };
}

export async function listStores(db: Db): Promise<StoreWithUpstream[]> {
  const { rows } = await db.query<JoinedRow>(
    `SELECT ${S}, ${U} FROM stores s JOIN upstreams u ON u.id = s.id ORDER BY u.slug`,
  );
  return rows.map(split);
}

export async function findStore(
  db: Db,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<StoreWithUpstream | null> {
  const { rows } = await db.query<JoinedRow>(
    `SELECT ${S}, ${U} FROM stores s JOIN upstreams u ON u.id = s.id WHERE s.id = $1
     ${opts.forUpdate ? 'FOR UPDATE OF s, u' : ''}`,
    [id],
  );
  return rows[0] ? split(rows[0]) : null;
}

export async function countStores(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM stores');
  return Number(rows[0]!.n);
}

export async function insertStore(
  db: Db,
  s: { id: string; adminEmail: string; createdBy: string },
): Promise<void> {
  await db.query(
    `INSERT INTO stores (id, admin_email, reason, created_by)
     VALUES ($1, $2, 'Creating the namespace', $3)`,
    [s.id, s.adminEmail, s.createdBy],
  );
}

/** Member read-only defaults for the store's slug (idempotent). */
export async function grantMemberDefaults(db: Db, slug: string): Promise<void> {
  await db.query(
    `INSERT INTO tool_permissions (role, server_slug, tool, effect)
     SELECT 'member', $1, t, 'allow' FROM unnest($2::text[]) AS t
     ON CONFLICT DO NOTHING`,
    [slug, [...MEMBER_DEFAULT_TOOLS]],
  );
}

/** Written by the provisioner (lease holder) only. False if the row is gone. */
export async function setStorePhase(
  db: Db,
  id: string,
  phase: StoreRow['phase'],
  reason: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stores SET phase = $2, reason = $3, last_reconciled_at = now(),
       updated_at = CASE WHEN phase IS DISTINCT FROM $2 OR reason IS DISTINCT FROM $3
                         THEN now() ELSE updated_at END
     WHERE id = $1 AND (desired_state = 'present' OR $2 = 'deleting')`,
    [id, phase, reason],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete requested: the upstream is disabled at once, so its tools disappear immediately. */
export async function markStoreAbsent(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH s AS (
       UPDATE stores SET desired_state = 'absent', phase = 'deleting',
         reason = 'Deleting the namespace (volumes included)', updated_at = now()
       WHERE id = $1 RETURNING id)
     UPDATE upstreams SET enabled = false, updated_at = now() WHERE id IN (SELECT id FROM s)`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Retry a failed store: new bootstrap generation, fresh timeout. False unless it was failed. */
export async function retryStore(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stores SET phase = 'provisioning', reason = 'Retrying', generation = generation + 1,
       provision_started_at = now(), updated_at = now()
     WHERE id = $1 AND phase = 'failed' AND desired_state = 'present'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * After its namespace is gone: the store's permission rules (role and per-user rules for its slug)
 * and the upstream row (cascades to stores) in one transaction. Audit rows are kept (history).
 */
export async function deleteStoreRows(db: pg.Pool, id: string, slug: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM tool_permissions WHERE server_slug = $1`, [slug]);
    await client.query(`DELETE FROM upstreams WHERE id = $1 AND store`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The store's woo-mcp is ready: register the upstream (enable it). */
export async function enableStoreUpstream(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE upstreams SET enabled = true, updated_at = now()
     WHERE id = $1 AND store AND NOT enabled
       AND EXISTS (SELECT 1 FROM stores WHERE id = $1 AND desired_state = 'present')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export function toStore(
  row: StoreWithUpstream,
  view: { storefrontUrl: string; toolCount: number },
): Store {
  return StoreSchema.parse({
    id: row.id,
    slug: row.upstream.slug,
    name: row.upstream.name,
    adminEmail: row.admin_email,
    namespace: storeNamespace(row.upstream.slug),
    storefrontUrl: view.storefrontUrl,
    phase: row.phase,
    reason: row.reason,
    upstreamEnabled: row.upstream.enabled,
    upstreamStatus: row.upstream.status,
    toolCount: view.toolCount,
    generation: row.generation,
    provisionStartedAt: row.provision_started_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
