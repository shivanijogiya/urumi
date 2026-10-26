// Single-writer jobs across gateway replicas (ADR 010): a named lease in Postgres table
// gateway_leases. `tryAcquire()` takes the lease if it is free or expired, or renews it if this
// replica already holds it, in one atomic UPSERT. The health loop calls it at the start of every
// tick and runs the tick only while it holds the lease, so exactly one replica pings upstreams and
// writes status / last_error / last_checked_at. If the holder dies, another replica takes over
// once the lease expires (ttl, default 45 s = three 15 s ticks); a clean shutdown releases it.
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;

export const HEALTH_LEASE = 'health';
export const DEFAULT_LEASE_TTL_MS = 45_000;

export class Lease {
  constructor(
    private readonly db: Db,
    readonly name: string,
    /** This replica's identity: the pod name (HOSTNAME) in Kubernetes. */
    readonly holder: string,
    readonly ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ) {}

  /** True if this replica holds the lease after the call (acquired or renewed). */
  async tryAcquire(): Promise<boolean> {
    const { rows } = await this.db.query<{ holder: string }>(
      `INSERT INTO gateway_leases AS l (name, holder, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (name) DO UPDATE
         SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
         WHERE l.holder = EXCLUDED.holder OR l.expires_at < now()
       RETURNING holder`,
      [this.name, this.holder, this.ttlMs / 1000],
    );
    return rows[0]?.holder === this.holder;
  }

  /** Gives the lease up now (shutdown), so another replica takes over on its next tick. */
  async release(): Promise<void> {
    await this.db.query(`DELETE FROM gateway_leases WHERE name = $1 AND holder = $2`, [
      this.name,
      this.holder,
    ]);
  }

  /** Current holder, or null if none or expired. */
  static async current(db: Db, name: string): Promise<{ holder: string; expiresAt: Date } | null> {
    const { rows } = await db.query<{ holder: string; expires_at: Date }>(
      `SELECT holder, expires_at FROM gateway_leases WHERE name = $1 AND expires_at >= now()`,
      [name],
    );
    return rows[0] ? { holder: rows[0].holder, expiresAt: rows[0].expires_at } : null;
  }
}
