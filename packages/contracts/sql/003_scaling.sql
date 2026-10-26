-- Scaling (ADR 010): state the gateway replicas share, so any replica can serve any request.
--
-- rate_limit_buckets: one token bucket per limited principal (`key:<api key id>`,
-- `user:<user id>`). A request takes one token in a single atomic UPSERT that first refills the
-- bucket for the time elapsed (Postgres clock, so replicas agree). No secrets, no request data.
CREATE TABLE rate_limit_buckets (
  key        text PRIMARY KEY CHECK (length(key) <= 100),
  tokens     double precision NOT NULL,
  updated_at timestamptz NOT NULL
);

-- gateway_leases: named leases with an expiry. The upstream health loop runs only on the replica
-- holding the `health` lease, so status / last_error / last_checked_at have exactly one writer.
CREATE TABLE gateway_leases (
  name       text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  holder     text NOT NULL CHECK (length(holder) <= 253),
  expires_at timestamptz NOT NULL
);

-- A refused (rate-limited) /mcp request is audited too.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_outcome_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_outcome_check
  CHECK (outcome IN ('ok', 'error', 'timeout', 'denied', 'rate_limited'));
