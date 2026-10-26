// SQL for hosted servers (ADR 014). Parameterized queries only. The sealed env stays in this module
// and the reconciler (which opens it only to build the Secret); API objects go through toHosted and
// the strict HostedServerSchema, which has no field for values.
import { HostedServerSchema, type HostedServer } from '@urumi/contracts';
import type { HostedServerRow, UpstreamRow } from '@urumi/contracts/db';
import type pg from 'pg';
import { decrypt, encrypt, type Sealed } from '../crypto/secretbox.js';

type Db = pg.Pool | pg.PoolClient;

/** A hosted row joined with the upstream row it owns. */
export type HostedWithUpstream = HostedServerRow & {
  upstream: Pick<
    UpstreamRow,
    'id' | 'slug' | 'name' | 'url' | 'enabled' | 'status' | 'last_error' | 'updated_at'
  >;
};

const H = `h.id, h.image, h.image_digest, h.port, h.mcp_path, h.preset, h.egress, h.env_keys,
  h.env_ciphertext, h.env_iv, h.env_tag, h.desired_state, h.phase, h.reason, h.created_by,
  h.created_at, h.updated_at, h.last_reconciled_at`;
const U = `u.slug AS u_slug, u.name AS u_name, u.url AS u_url, u.enabled AS u_enabled,
  u.status AS u_status, u.last_error AS u_last_error, u.updated_at AS u_updated_at`;

type JoinedRow = HostedServerRow & {
  u_slug: string;
  u_name: string;
  u_url: string;
  u_enabled: boolean;
  u_status: UpstreamRow['status'];
  u_last_error: string | null;
  u_updated_at: Date;
};

function split(r: JoinedRow): HostedWithUpstream {
  const { u_slug, u_name, u_url, u_enabled, u_status, u_last_error, u_updated_at, ...h } = r;
  return {
    ...h,
    upstream: {
      id: h.id,
      slug: u_slug,
      name: u_name,
      url: u_url,
      enabled: u_enabled,
      status: u_status,
      last_error: u_last_error,
      updated_at: u_updated_at,
    },
  };
}

export async function listHosted(db: Db): Promise<HostedWithUpstream[]> {
  const { rows } = await db.query<JoinedRow>(
    `SELECT ${H}, ${U} FROM hosted_servers h JOIN upstreams u ON u.id = h.id ORDER BY u.slug`,
  );
  return rows.map(split);
}

export async function findHosted(
  db: Db,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<HostedWithUpstream | null> {
  const { rows } = await db.query<JoinedRow>(
    `SELECT ${H}, ${U} FROM hosted_servers h JOIN upstreams u ON u.id = h.id WHERE h.id = $1
     ${opts.forUpdate ? 'FOR UPDATE OF h, u' : ''}`,
    [id],
  );
  return rows[0] ? split(rows[0]) : null;
}

export async function countHosted(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM hosted_servers');
  return Number(rows[0]!.n);
}

/** AAD binds the sealed env to its server. */
const envAad = (id: string) => `hosted-env:${id}`;

export function sealEnv(
  key: Buffer,
  id: string,
  env: Record<string, string> | undefined,
): { keys: string[]; sealed: Sealed | null } {
  const keys = Object.keys(env ?? {}).sort();
  if (!env || keys.length === 0) return { keys: [], sealed: null };
  return { keys, sealed: encrypt(key, JSON.stringify(env), envAad(id)) };
}

export function openEnv(key: Buffer, row: HostedServerRow): Record<string, string> {
  if (!row.env_ciphertext || !row.env_iv || !row.env_tag) return {};
  const json = decrypt(
    key,
    {
      ciphertext: Buffer.from(row.env_ciphertext),
      iv: Buffer.from(row.env_iv),
      tag: Buffer.from(row.env_tag),
    },
    envAad(row.id),
  );
  return JSON.parse(json) as Record<string, string>;
}

export async function insertHosted(
  db: Db,
  h: {
    id: string;
    image: string;
    imageDigest: string | null;
    port: number;
    mcpPath: string;
    preset: 'small' | 'medium';
    egress: boolean;
    envKeys: string[];
    sealed: Sealed | null;
    createdBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO hosted_servers (id, image, image_digest, port, mcp_path, preset, egress, env_keys,
       env_ciphertext, env_iv, env_tag, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      h.id,
      h.image,
      h.imageDigest,
      h.port,
      h.mcpPath,
      h.preset,
      h.egress,
      h.envKeys,
      h.sealed?.ciphertext ?? null,
      h.sealed?.iv ?? null,
      h.sealed?.tag ?? null,
      h.createdBy,
    ],
  );
}

/** Spec change from PATCH: back to deploying; `env` undefined keeps the stored env. */
export async function updateHostedSpec(
  db: Db,
  id: string,
  patch: {
    image?: string;
    imageDigest?: string | null;
    preset?: 'small' | 'medium';
    egress?: boolean;
    env?: { keys: string[]; sealed: Sealed | null };
  },
): Promise<void> {
  const setEnv = patch.env !== undefined;
  await db.query(
    `UPDATE hosted_servers SET
       image = COALESCE($2, image),
       image_digest = CASE WHEN $2 IS NULL THEN image_digest ELSE $3 END,
       preset = COALESCE($4, preset),
       egress = COALESCE($5, egress),
       env_keys = CASE WHEN $6 THEN $7::text[] ELSE env_keys END,
       env_ciphertext = CASE WHEN $6 THEN $8::bytea ELSE env_ciphertext END,
       env_iv = CASE WHEN $6 THEN $9::bytea ELSE env_iv END,
       env_tag = CASE WHEN $6 THEN $10::bytea ELSE env_tag END,
       phase = 'deploying', reason = 'Applying the new configuration', updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.image ?? null,
      patch.imageDigest ?? null,
      patch.preset ?? null,
      patch.egress ?? null,
      setEnv,
      patch.env?.keys ?? [],
      patch.env?.sealed?.ciphertext ?? null,
      patch.env?.sealed?.iv ?? null,
      patch.env?.sealed?.tag ?? null,
    ],
  );
}

/** Written by the reconciler (lease holder) only. False if the row is gone. */
export async function setHostedPhase(
  db: Db,
  id: string,
  phase: HostedServerRow['phase'],
  reason: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE hosted_servers SET phase = $2, reason = $3, last_reconciled_at = now(),
       updated_at = CASE WHEN phase IS DISTINCT FROM $2 OR reason IS DISTINCT FROM $3
                         THEN now() ELSE updated_at END
     WHERE id = $1`,
    [id, phase, reason],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete requested: the upstream is disabled at once, so its tools disappear immediately. */
export async function markHostedAbsent(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH h AS (
       UPDATE hosted_servers SET desired_state = 'absent', phase = 'deleting', reason = NULL,
         updated_at = now()
       WHERE id = $1 RETURNING id)
     UPDATE upstreams SET enabled = false, updated_at = now() WHERE id IN (SELECT id FROM h)`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** After its Kubernetes objects are gone: removes the upstream row (cascades to hosted_servers). */
export async function deleteHostedRows(db: Db, id: string): Promise<void> {
  await db.query(`DELETE FROM upstreams WHERE id = $1 AND hosted`, [id]);
}

/** The pod is ready: register the upstream (enable it). */
export async function enableHostedUpstream(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE upstreams SET enabled = true, updated_at = now()
     WHERE id = $1 AND hosted AND NOT enabled
       AND EXISTS (SELECT 1 FROM hosted_servers WHERE id = $1 AND desired_state = 'present')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export function toHosted(row: HostedWithUpstream, toolCount: number): HostedServer {
  return HostedServerSchema.parse({
    id: row.id,
    slug: row.upstream.slug,
    name: row.upstream.name,
    image: row.image,
    imageDigest: row.image_digest,
    port: row.port,
    mcpPath: row.mcp_path,
    preset: row.preset,
    egress: row.egress,
    envKeys: row.env_keys,
    phase: row.phase,
    reason: row.reason,
    url: row.upstream.url,
    toolCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
