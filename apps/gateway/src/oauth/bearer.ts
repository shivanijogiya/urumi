// Resource Server half of ADR 013: resolves `Authorization: Bearer uat_…` on /mcp to the grant's
// user. Like API keys (auth/api-keys.ts): only sha256 is looked up, anything that is not a live
// token of a live grant of an enabled user is null (→ the same detail-free 401), and last use is
// recorded in the background at most once a minute.
import { ACCESS_TOKEN_PREFIX, type User } from '@urumi/contracts';
import type pg from 'pg';
import { sha256 } from './crypto.js';
import { findAccessToken, touchGrant } from './repo.js';

const ACCESS_RE = new RegExp(`^Bearer (${ACCESS_TOKEN_PREFIX}[A-Za-z0-9_-]{43})$`);
const TOUCH_INTERVAL_MS = 60_000;

export function looksLikeAccessToken(header: string | undefined): boolean {
  return header !== undefined && ACCESS_RE.test(header);
}

export async function authenticateAccessToken(
  pool: pg.Pool,
  authorizationHeader: string | undefined,
  expectedResource: string,
): Promise<{ user: User; grantId: string; clientName: string } | null> {
  const match = authorizationHeader ? ACCESS_RE.exec(authorizationHeader) : null;
  if (!match) return null;
  const found = await findAccessToken(pool, sha256(match[1]!));
  if (!found || found.user.disabledAt) return null;
  // Audience: a token is only good for the resource it was issued for (RFC 8707).
  if (found.resource !== expectedResource) return null;
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    touchGrant(pool, found.grantId).catch(() => undefined);
  }
  return { user: found.user, grantId: found.grantId, clientName: found.clientName };
}
