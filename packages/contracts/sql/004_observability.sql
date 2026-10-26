-- Observability (ADR 011): say precisely why an upstream is unreachable or a call failed, and
-- when an upstream last worked. Additive only: the previous gateway image ignores the columns.
--
-- upstreams.last_ok_at: last health check that succeeded (written by the health-lease holder).
ALTER TABLE upstreams ADD COLUMN last_ok_at timestamptz;
UPDATE upstreams SET last_ok_at = last_checked_at WHERE status = 'up';

-- audit_log.error_detail: the fixed-vocabulary reason of a failed call ('Timed out',
-- 'Host did not resolve', 'Connection failed (ECONNREFUSED)', 'HTTP 503', 'MCP error -32603', …).
-- Never raw upstream text, URLs or credentials (the gateway only writes its own fixed strings).
ALTER TABLE audit_log ADD COLUMN error_detail text CHECK (length(error_detail) <= 200);

-- The Health page aggregates calls per server over a time window.
CREATE INDEX audit_log_server_started_idx ON audit_log (server_slug, started_at DESC);
