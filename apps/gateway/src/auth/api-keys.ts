// API keys for external MCP clients. The secret is `urk_` + base64url(32 random bytes), shown once.
// The database keeps sha256(secret) (api_keys.key_hash) and the first 8 characters for display.
import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_PREFIX, type User } from '@urumi/contracts';
import type pg from 'pg';
import { findKeyByHash, touchKey } from '../keys/repo.js';

/** Exactly `Bearer urk_<43 base64url chars>`; nothing else is a key. */
const BEARER_RE = /^Bearer (urk_[A-Za-z0-9_-]{43})$/;
const DISPLAY_PREFIX_LENGTH = 8;
/** last_used_at is written at most this often per key (one UPDATE per minute, not per call). */
const TOUCH_INTERVAL_MS = 60_000;

export interface GeneratedKey {
  secret: string;
  prefix: string;
  hash: Buffer;
}

export function hashApiKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function generateApiKey(): GeneratedKey {
  const secret = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { secret, prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(secret) };
}

/**
 * Resolves an `Authorization` header to the key's user, or null for anything that is not a live
 * key of an enabled user (malformed, unknown, revoked, disabled). Callers answer null with a
 * detail-free 401. Records last use in the background.
 */
export async function authenticateApiKey(
  pool: pg.Pool,
  authorizationHeader: string | undefined,
): Promise<{ user: User; keyId: string } | null> {
  const match = authorizationHeader ? BEARER_RE.exec(authorizationHeader) : null;
  if (!match) return null;
  const found = await findKeyByHash(pool, hashApiKey(match[1]!));
  if (!found || found.revokedAt || found.user.disabledAt) return null;

  if (!found.lastUsedAt || Date.now() - found.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    // Fire-and-forget: a failed bookkeeping write must not fail the request.
    touchKey(pool, found.keyId).catch(() => undefined);
  }
  return { user: found.user, keyId: found.keyId };
}
