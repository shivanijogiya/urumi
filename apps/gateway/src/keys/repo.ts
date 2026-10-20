// SQL for api_keys. Parameterized queries only; key_hash never leaves this module.
import type { ApiKey, User } from '@urumi/contracts';
import type pg from 'pg';
import { toUser, USER_COLUMNS, type UserRow } from '../users/repo.js';

type Db = pg.Pool | pg.PoolClient;

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const KEY_COLUMNS = 'k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at';

function toApiKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

/** Newest first, revoked keys included (they show as revoked). */
export async function listKeys(db: Db, userId: string): Promise<ApiKey[]> {
  const { rows } = await db.query<KeyRow>(
    `SELECT ${KEY_COLUMNS} FROM api_keys k WHERE k.user_id = $1 ORDER BY k.created_at DESC, k.id`,
    [userId],
  );
  return rows.map(toApiKey);
}

export async function insertKey(
  db: Db,
  key: { userId: string; name: string; prefix: string; hash: Buffer },
): Promise<ApiKey> {
  const { rows } = await db.query<KeyRow>(
    `INSERT INTO api_keys AS k (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
     RETURNING ${KEY_COLUMNS}`,
    [key.userId, key.name, key.prefix, key.hash],
  );
  return toApiKey(rows[0]!);
}

/**
 * Sets revoked_at on the user's key (keeping the first revocation time). False when the key does
 * not exist or belongs to someone else, so callers answer 404 either way.
 */
export async function revokeKey(db: Db, userId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function findKeyByHash(
  db: Db,
  hash: Buffer,
): Promise<{ keyId: string; lastUsedAt: Date | null; revokedAt: Date | null; user: User } | null> {
  const { rows } = await db.query<
    UserRow & { key_id: string; last_used_at: Date | null; revoked_at: Date | null }
  >(
    `SELECT k.id AS key_id, k.last_used_at, k.revoked_at, ${USER_COLUMNS}
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    keyId: row.key_id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    user: toUser(row),
  };
}

export async function touchKey(db: Db, keyId: string): Promise<void> {
  await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyId]);
}
