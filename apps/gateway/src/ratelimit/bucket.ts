// Token-bucket rate limits shared by every gateway replica (ADR 010). One bucket per principal
// (`key:<api key id>`, `user:<user id>`) in Postgres table rate_limit_buckets. Taking a token is ONE
// atomic statement: UPSERT that refills the bucket for the time since its last update (Postgres
// clock: `now()`, so replicas never disagree about time) and takes a token only if at least one is
// there. Concurrent requests for the same bucket serialise on its row lock, so N replicas together
// never let more than `burst` + `perMinute`·t requests through in t minutes.
//
// A refused request does not touch the row (no token is taken, refill keeps running), so retrying
// after Retry-After seconds succeeds.
import type pg from 'pg';

export interface BucketLimit {
  /** Sustained rate: tokens added per minute. */
  perMinute: number;
  /** Bucket size: the most requests allowed back to back. */
  burst: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Whole seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
  /** Tokens left after this request (fractional; for logs and tests). */
  remaining: number;
}

type Db = Pick<pg.Pool, 'query'>;

/** Seconds until `tokens` (< 1) has refilled to 1 at `perMinute`, rounded up, at least 1. */
export function retryAfterSeconds(tokens: number, perMinute: number): number {
  if (perMinute <= 0) return 60;
  const missing = Math.max(0, 1 - tokens);
  return Math.max(1, Math.ceil((missing * 60) / perMinute));
}

/** Refill math, shared with the SQL below: tokens after `elapsedSec`, capped at the burst. */
export function refill(tokens: number, elapsedSec: number, limit: BucketLimit): number {
  return Math.min(limit.burst, tokens + (Math.max(0, elapsedSec) * limit.perMinute) / 60);
}

const TAKE_SQL = `
  INSERT INTO rate_limit_buckets AS b (key, tokens, updated_at)
  VALUES ($1, $2::double precision - 1, now())
  ON CONFLICT (key) DO UPDATE SET
    tokens = LEAST($2::double precision,
                   b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * $3::double precision) - 1,
    updated_at = now()
  WHERE LEAST($2::double precision,
              b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * $3::double precision) >= 1
  RETURNING tokens`;

const PEEK_SQL = `
  SELECT LEAST($2::double precision,
               tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::double precision) AS tokens
  FROM rate_limit_buckets WHERE key = $1`;

export class PgTokenBucket {
  constructor(private readonly db: Db) {}

  /** Takes one token from `key`'s bucket if it has one. A limit with burst 0 means unlimited. */
  async take(key: string, limit: BucketLimit): Promise<TakeResult> {
    if (limit.burst <= 0 || limit.perMinute <= 0) {
      return { allowed: true, retryAfterSeconds: 0, remaining: Infinity };
    }
    const perSecond = limit.perMinute / 60;
    const taken = await this.db.query<{ tokens: number }>(TAKE_SQL, [key, limit.burst, perSecond]);
    if (taken.rows[0]) {
      return { allowed: true, retryAfterSeconds: 0, remaining: Number(taken.rows[0].tokens) };
    }
    const peek = await this.db.query<{ tokens: number }>(PEEK_SQL, [key, limit.burst, perSecond]);
    const tokens = Number(peek.rows[0]?.tokens ?? 0);
    return {
      allowed: false,
      retryAfterSeconds: retryAfterSeconds(tokens, limit.perMinute),
      remaining: tokens,
    };
  }

  /** Deletes buckets idle long enough to be full again (housekeeping; safe on any replica). */
  async prune(olderThanSeconds = 3600): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM rate_limit_buckets WHERE updated_at < now() - make_interval(secs => $1)`,
      [olderThanSeconds],
    );
    return rowCount ?? 0;
  }
}

export interface McpRateLimits {
  perKey: BucketLimit;
  perUser: BucketLimit;
}

export interface McpLimitDecision extends TakeResult {
  /** Which limit refused the request; null when allowed. */
  scope: 'key' | 'user' | null;
}

/**
 * /mcp: the per-API-key bucket, then the per-user bucket (a user with several keys shares one
 * user budget). The key's token is spent even if the user bucket then refuses: a refused request
 * still cost the gateway a round trip, and it keeps the check to two statements.
 */
export async function checkMcpLimits(
  bucket: PgTokenBucket,
  limits: McpRateLimits,
  caller: { keyId: string; userId: string },
): Promise<McpLimitDecision> {
  const byKey = await bucket.take(`key:${caller.keyId}`, limits.perKey);
  if (!byKey.allowed) return { ...byKey, scope: 'key' };
  const byUser = await bucket.take(`user:${caller.userId}`, limits.perUser);
  if (!byUser.allowed) return { ...byUser, scope: 'user' };
  return { ...byUser, remaining: Math.min(byKey.remaining, byUser.remaining), scope: null };
}
