-- 001_init: users, sessions, API keys, upstream registry, audit log. Postgres 16.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text NOT NULL, -- scrypt
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE sessions (
  id         text PRIMARY KEY, -- sha256 hex of the cookie token
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL, -- first 8 chars of the secret, for display
  key_hash     bytea NOT NULL UNIQUE, -- sha256 of the secret
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE upstreams (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$'),
  name                   text NOT NULL,
  url                    text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  credential_type        text NOT NULL DEFAULT 'none' CHECK (credential_type IN ('none', 'bearer', 'header')),
  credential_header_name text, -- set only for type 'header'
  credential_ciphertext  bytea, -- AES-256-GCM
  credential_iv          bytea,
  credential_tag         bytea,
  status                 text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'up', 'down')),
  last_error             text,
  last_checked_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upstreams_credential_complete CHECK (
    (credential_type = 'none') = (credential_ciphertext IS NULL)
    AND (credential_ciphertext IS NULL) = (credential_iv IS NULL)
    AND (credential_ciphertext IS NULL) = (credential_tag IS NULL)
    AND (credential_type = 'header') = (credential_header_name IS NOT NULL)
  )
);

-- One row per tool call through callTool. Arguments and results are NOT stored (customer data).
-- Unauthenticated requests have no user, so they are not audit rows; they are logged as HTTP 401.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users,
  api_key_id  uuid REFERENCES api_keys, -- null for chat
  source      text NOT NULL CHECK (source IN ('mcp', 'chat')),
  server_slug text NOT NULL,
  tool        text NOT NULL,
  started_at  timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout', 'denied')),
  error_code  text
);
CREATE INDEX audit_log_user_started_idx ON audit_log (user_id, started_at DESC);
CREATE INDEX audit_log_started_idx ON audit_log (started_at DESC);
