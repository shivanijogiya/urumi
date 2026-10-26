// SQL for the OAuth tables (005_oauth.sql, ADR 013). Parameterized queries only. Every lookup is by
// sha256 of the presented value; hashes never leave this module. Single-use rows (pending
// requests, codes, refresh tokens) are consumed with one conditional UPDATE/DELETE … RETURNING,
// so two replicas racing on the same value cannot both succeed.
import type { ConnectedApp, OAuthClientRow, User } from '@urumi/contracts';
import type pg from 'pg';
import { toUser, USER_COLUMNS, type UserRow } from '../users/repo.js';

type Db = pg.Pool | pg.PoolClient;
export type AuthMethod = OAuthClientRow['token_endpoint_auth_method'];
export type RevokeReason = 'user' | 'admin' | 'client' | 'refresh_reuse' | 'code_reuse';

// ── Clients ─────────────────────────────────────────────────────────────────────────────────
export async function insertClient(
  db: Db,
  c: { name: string; redirectUris: string[]; authMethod: AuthMethod; secretHash: Buffer | null },
): Promise<OAuthClientRow> {
  const { rows } = await db.query<OAuthClientRow>(
    `INSERT INTO oauth_clients (client_name, redirect_uris, token_endpoint_auth_method, secret_hash)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [c.name, c.redirectUris, c.authMethod, c.secretHash],
  );
  return rows[0]!;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findClient(db: Db, clientId: unknown): Promise<OAuthClientRow | null> {
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return null;
  const { rows } = await db.query<OAuthClientRow>('SELECT * FROM oauth_clients WHERE id = $1', [
    clientId,
  ]);
  return rows[0] ?? null;
}

// ── Pending authorization requests ──────────────────────────────────────────────────────────
export interface AuthRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string;
  userId: string | null;
}

export async function insertAuthRequest(
  db: Db,
  r: Omit<AuthRequest, 'clientName' | 'userId'> & { idHash: string; ttlSeconds: number },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_auth_requests
       (id_hash, client_id, redirect_uri, code_challenge, state, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [
      r.idHash,
      r.clientId,
      r.redirectUri,
      r.codeChallenge,
      r.state,
      r.scope,
      r.resource,
      r.ttlSeconds,
    ],
  );
}

interface AuthRequestRow {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string;
  resource: string;
  user_id: string | null;
}

const toAuthRequest = (r: AuthRequestRow): AuthRequest => ({
  clientId: r.client_id,
  clientName: r.client_name,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  state: r.state,
  scope: r.scope,
  resource: r.resource,
  userId: r.user_id,
});

/**
 * Binds a live pending request to `userId` (the first signed-in viewer; nobody else can see or
 * decide it afterwards) and replaces its consent token. Null if expired, unknown, or another
 * user's.
 */
export async function bindAuthRequest(
  db: Db,
  idHash: string,
  userId: string,
  consentTokenHash: string,
): Promise<AuthRequest | null> {
  const { rows } = await db.query<AuthRequestRow>(
    `UPDATE oauth_auth_requests r SET user_id = $2, consent_token_hash = $3
     FROM oauth_clients c
     WHERE r.id_hash = $1 AND c.id = r.client_id AND r.expires_at > now()
       AND (r.user_id IS NULL OR r.user_id = $2)
     RETURNING r.client_id, c.client_name, r.redirect_uri, r.code_challenge, r.state, r.scope,
               r.resource, r.user_id`,
    [idHash, userId, consentTokenHash],
  );
  return rows[0] ? toAuthRequest(rows[0]) : null;
}

/** Deletes and returns the request iff it is live, this user's, and the consent token matches. */
export async function consumeAuthRequest(
  db: Db,
  idHash: string,
  userId: string,
  consentTokenHash: string,
): Promise<AuthRequest | null> {
  const { rows } = await db.query<AuthRequestRow>(
    `WITH gone AS (
       DELETE FROM oauth_auth_requests
       WHERE id_hash = $1 AND user_id = $2 AND consent_token_hash = $3 AND expires_at > now()
       RETURNING *)
     SELECT g.client_id, c.client_name, g.redirect_uri, g.code_challenge, g.state, g.scope,
            g.resource, g.user_id
     FROM gone g JOIN oauth_clients c ON c.id = g.client_id`,
    [idHash, userId, consentTokenHash],
  );
  return rows[0] ? toAuthRequest(rows[0]) : null;
}

// ── Grants, codes, tokens ───────────────────────────────────────────────────────────────────
export async function insertGrant(
  db: Db,
  g: { clientId: string; userId: string; scope: string; resource: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO oauth_grants (client_id, user_id, scope, resource) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [g.clientId, g.userId, g.scope, g.resource],
  );
  return rows[0]!.id;
}

export async function insertCode(
  db: Db,
  c: {
    hash: Buffer;
    grantId: string;
    redirectUri: string;
    codeChallenge: string;
    ttlSeconds: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [c.hash, c.grantId, c.redirectUri, c.codeChallenge, c.ttlSeconds],
  );
}

export interface RedeemedCode {
  grantId: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  grantRevoked: boolean;
}

export type CodeRedemption =
  | { status: 'ok'; code: RedeemedCode }
  | { status: 'reused'; grantId: string; clientId: string }
  | { status: 'invalid' };

/**
 * Marks the code used (once, ever) and returns what it was bound to. A code that was already used
 * is reported as `reused` (the caller revokes its grant); unknown or expired is `invalid`.
 */
export async function redeemCode(db: Db, hash: Buffer): Promise<CodeRedemption> {
  const { rows } = await db.query<{
    grant_id: string;
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string;
    revoked_at: Date | null;
  }>(
    `UPDATE oauth_codes k SET used_at = now()
     FROM oauth_grants g
     WHERE k.code_hash = $1 AND k.used_at IS NULL AND k.expires_at > now() AND g.id = k.grant_id
     RETURNING k.grant_id, g.client_id, g.user_id, k.redirect_uri, k.code_challenge, g.scope,
               g.resource, g.revoked_at`,
    [hash],
  );
  const r = rows[0];
  if (r) {
    return {
      status: 'ok',
      code: {
        grantId: r.grant_id,
        clientId: r.client_id,
        userId: r.user_id,
        redirectUri: r.redirect_uri,
        codeChallenge: r.code_challenge,
        scope: r.scope,
        resource: r.resource,
        grantRevoked: r.revoked_at !== null,
      },
    };
  }
  const used = await db.query<{ grant_id: string; client_id: string }>(
    `SELECT k.grant_id, g.client_id FROM oauth_codes k JOIN oauth_grants g ON g.id = k.grant_id
     WHERE k.code_hash = $1 AND k.used_at IS NOT NULL`,
    [hash],
  );
  const u = used.rows[0];
  return u
    ? { status: 'reused', grantId: u.grant_id, clientId: u.client_id }
    : { status: 'invalid' };
}

export async function activateGrant(db: Db, grantId: string): Promise<void> {
  await db.query(
    'UPDATE oauth_grants SET activated_at = COALESCE(activated_at, now()) WHERE id = $1',
    [grantId],
  );
}

export async function insertToken(
  db: Db,
  t: { hash: Buffer; grantId: string; kind: 'access' | 'refresh'; ttlSeconds: number },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [t.hash, t.grantId, t.kind, t.ttlSeconds],
  );
}

export interface RotatedRefresh {
  grantId: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
  grantRevoked: boolean;
  userDisabled: boolean;
}

export type RefreshRotation =
  | { status: 'ok'; grant: RotatedRefresh }
  | { status: 'reused'; grantId: string; clientId: string }
  | { status: 'invalid' };

/** Marks a live refresh token used (rotation). A second use of the same token is `reused`. */
export async function rotateRefreshToken(db: Db, hash: Buffer): Promise<RefreshRotation> {
  const { rows } = await db.query<{
    grant_id: string;
    client_id: string;
    user_id: string;
    scope: string;
    resource: string;
    revoked_at: Date | null;
    disabled_at: Date | null;
  }>(
    `UPDATE oauth_tokens t SET used_at = now()
     FROM oauth_grants g JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.used_at IS NULL
       AND t.expires_at > now() AND g.id = t.grant_id
     RETURNING t.grant_id, g.client_id, g.user_id, g.scope, g.resource, g.revoked_at,
               u.disabled_at`,
    [hash],
  );
  const r = rows[0];
  if (r) {
    return {
      status: 'ok',
      grant: {
        grantId: r.grant_id,
        clientId: r.client_id,
        userId: r.user_id,
        scope: r.scope,
        resource: r.resource,
        grantRevoked: r.revoked_at !== null,
        userDisabled: r.disabled_at !== null,
      },
    };
  }
  const used = await db.query<{ grant_id: string; client_id: string }>(
    `SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.used_at IS NOT NULL`,
    [hash],
  );
  const u = used.rows[0];
  return u
    ? { status: 'reused', grantId: u.grant_id, clientId: u.client_id }
    : { status: 'invalid' };
}

/** A live access token of a live grant: its user (enabled or not, the caller checks) and grant. */
export async function findAccessToken(
  db: Db,
  hash: Buffer,
): Promise<{
  grantId: string;
  clientId: string;
  clientName: string;
  resource: string;
  lastUsedAt: Date | null;
  user: User;
} | null> {
  const { rows } = await db.query<
    UserRow & {
      grant_id: string;
      client_id: string;
      client_name: string;
      resource: string;
      last_used_at: Date | null;
    }
  >(
    `SELECT t.grant_id, g.client_id, c.client_name, g.resource, g.last_used_at, ${USER_COLUMNS}
     FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN oauth_clients c ON c.id = g.client_id
       JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now()
       AND g.revoked_at IS NULL`,
    [hash],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    grantId: r.grant_id,
    clientId: r.client_id,
    clientName: r.client_name,
    resource: r.resource,
    lastUsedAt: r.last_used_at,
    user: toUser(r),
  };
}

export async function touchGrant(db: Db, grantId: string): Promise<void> {
  await db.query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [grantId]);
}

/**
 * Revokes a grant (keeps the first revocation) and deletes its tokens and codes, so access and
 * refresh tokens stop working on the next request on every replica. `ownerId` restricts it to
 * that user's grant (members); null = any grant (admins, reuse detection). True if found.
 */
export async function revokeGrant(
  db: Db,
  grantId: string,
  reason: RevokeReason,
  ownerId: string | null = null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH g AS (
       UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()),
                               revoke_reason = COALESCE(revoke_reason, $2)
       WHERE id = $1 AND ($3::uuid IS NULL OR user_id = $3::uuid)
       RETURNING id),
     t AS (DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM g)),
     k AS (DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM g) AND used_at IS NULL)
     SELECT id FROM g`,
    [grantId, reason, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

/** RFC 7009: the grant of a token presented by `clientId`, if the token exists. */
export async function findTokenGrant(
  db: Db,
  hash: Buffer,
): Promise<{ grantId: string; clientId: string; kind: 'access' | 'refresh' } | null> {
  const { rows } = await db.query<{
    grant_id: string;
    client_id: string;
    kind: 'access' | 'refresh';
  }>(
    `SELECT t.grant_id, g.client_id, t.kind FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1`,
    [hash],
  );
  const r = rows[0];
  return r ? { grantId: r.grant_id, clientId: r.client_id, kind: r.kind } : null;
}

export async function deleteToken(db: Db, hash: Buffer): Promise<void> {
  await db.query('DELETE FROM oauth_tokens WHERE token_hash = $1', [hash]);
}

// ── Connected apps (dashboard) ──────────────────────────────────────────────────────────────
interface AppRow {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  user_id: string;
  user_email: string;
  scope: string;
  activated_at: Date;
  last_used_at: Date | null;
}

/** Live, activated grants, newest first; of `userId`, or everyone's when null (admins). */
export async function listConnectedApps(
  db: Db,
  userId: string | null,
): Promise<(Omit<ConnectedApp, 'redirectHosts'> & { redirectUris: string[] })[]> {
  const { rows } = await db.query<AppRow>(
    `SELECT g.id, g.client_id, c.client_name, c.redirect_uris, g.user_id, u.email AS user_email,
            g.scope, g.activated_at, g.last_used_at
     FROM oauth_grants g
       JOIN oauth_clients c ON c.id = g.client_id
       JOIN users u ON u.id = g.user_id
     WHERE g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       AND ($1::uuid IS NULL OR g.user_id = $1::uuid)
     ORDER BY g.activated_at DESC, g.id
     LIMIT 500`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    redirectUris: r.redirect_uris,
    userId: r.user_id,
    userEmail: r.user_email,
    scope: r.scope,
    authorizedAt: r.activated_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
  }));
}

// ── Housekeeping ────────────────────────────────────────────────────────────────────────────
/**
 * Deletes what can no longer be used: expired pending requests, codes and tokens (an hour of
 * slack keeps used codes/tokens around for reuse detection), and registered clients that never
 * got a grant within a day (abandoned or abusive Dynamic Client Registrations). Safe on any
 * replica; cheap with the expiry indexes.
 */
export async function pruneOAuth(db: Db): Promise<void> {
  await db.query(`DELETE FROM oauth_auth_requests WHERE expires_at < now()`);
  await db.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`);
  await db.query(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 hour'`);
  await db.query(
    `DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)`,
  );
}
