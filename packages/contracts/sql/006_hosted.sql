-- Hosted MCP servers (ADR 014): an admin adds an MCP server by container image; the gateway runs it
-- in the hosted namespace (Deployment + Service + Secret) and registers it as an upstream once its
-- pod is ready. Additive only: the previous gateway image ignores the new table and column (a
-- hosted upstream row then looks like a disabled or ordinary in-cluster upstream to it).

-- Upstream rows created for hosted servers. They are managed through /api/hosted-servers only
-- (the upstream PATCH/DELETE routes refuse them), and the SSRF guard allows exactly their
-- generated Service host at call time.
ALTER TABLE upstreams ADD COLUMN hosted boolean NOT NULL DEFAULT false;

-- One row per hosted server; id = its upstream row's id (1:1, deleted with it). The env values are
-- one AES-256-GCM sealed JSON object (AAD 'hosted-env:<id>'); only the names are stored in the
-- clear. desired_state 'absent' = delete requested: the reconciler removes the Kubernetes objects,
-- then the upstream row (which cascades here).
CREATE TABLE hosted_servers (
  id               uuid PRIMARY KEY REFERENCES upstreams ON DELETE CASCADE,
  image            text NOT NULL CHECK (length(image) BETWEEN 1 AND 512),
  image_digest     text CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  port             integer NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  mcp_path         text NOT NULL CHECK (mcp_path ~ '^/[A-Za-z0-9._~/-]{0,127}$'),
  preset           text NOT NULL CHECK (preset IN ('small', 'medium')),
  egress           boolean NOT NULL DEFAULT false,
  env_keys         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(env_keys) <= 20),
  env_ciphertext   bytea,
  env_iv           bytea,
  env_tag          bytea,
  desired_state    text NOT NULL DEFAULT 'present' CHECK (desired_state IN ('present', 'absent')),
  phase            text NOT NULL DEFAULT 'deploying'
                   CHECK (phase IN ('deploying', 'connected', 'unreachable', 'failed', 'deleting')),
  reason           text CHECK (length(reason) <= 300),
  created_by       uuid REFERENCES users ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz,
  CONSTRAINT hosted_servers_env_complete CHECK (
    (env_ciphertext IS NULL) = (env_iv IS NULL)
    AND (env_ciphertext IS NULL) = (env_tag IS NULL)
    AND (env_ciphertext IS NULL) = (cardinality(env_keys) = 0)
  )
);
