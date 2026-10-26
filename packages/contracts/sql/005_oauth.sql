-- OAuth 2.1 for MCP clients (ADR 013): the gateway is the Authorization Server and the Resource
-- Server. Every secret-like value (client secret, pending-request id, consent token, code, access
-- and refresh token) is stored only as its SHA-256, like api_keys.key_hash. Additive only: the
-- previous gateway image ignores these tables and the new audit column.

-- Clients registered with Dynamic Client Registration (RFC 7591). Public clients (Claude Code,
-- Cursor, Inspector: token_endpoint_auth_method 'none') have no secret.
CREATE TABLE oauth_clients (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- = client_id
  client_name                text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 100),
  redirect_uris              text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  token_endpoint_auth_method text NOT NULL
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash                bytea, -- sha256 of the client secret; null for public clients
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_secret_matches_method
    CHECK ((token_endpoint_auth_method = 'none') = (secret_hash IS NULL))
);
CREATE INDEX oauth_clients_created_idx ON oauth_clients (created_at);

-- A validated /oauth/authorize request waiting for the user's decision (10 min). The browser holds
-- the random id; the consent page reads it with the user's session, which binds it to that user
-- and issues a one-time consent token (CSRF) that the decision POST must echo.
CREATE TABLE oauth_auth_requests (
  id_hash            text PRIMARY KEY, -- sha256 hex of the request id
  client_id          uuid NOT NULL REFERENCES oauth_clients ON DELETE CASCADE,
  redirect_uri       text NOT NULL,
  code_challenge     text NOT NULL,
  state              text,
  scope              text NOT NULL,
  resource           text NOT NULL,
  user_id            uuid REFERENCES users ON DELETE CASCADE, -- set when a signed-in user views it
  consent_token_hash text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX oauth_auth_requests_expires_idx ON oauth_auth_requests (expires_at);

-- One row per approved authorization (a "connected app"). It is the token family: revoking it
-- (user, admin, or refresh-token / code reuse detection) kills every access and refresh token in it.
CREATE TABLE oauth_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES oauth_clients ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  scope        text NOT NULL,
  resource     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz, -- first code exchange; only activated grants are "connected apps"
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('user', 'admin', 'client', 'refresh_reuse', 'code_reuse'))
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id);
CREATE INDEX oauth_grants_client_idx ON oauth_grants (client_id);

-- Authorization codes: single use, 60 s, bound to client + redirect_uri + PKCE challenge. The grant
-- exists from consent on, so a replayed code can revoke what its first redemption issued.
CREATE TABLE oauth_codes (
  code_hash      bytea PRIMARY KEY,
  grant_id       uuid NOT NULL REFERENCES oauth_grants ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

-- Access tokens (1 h) and refresh tokens (30 d, rotated on every use). Opaque random strings.
CREATE TABLE oauth_tokens (
  token_hash bytea PRIMARY KEY,
  grant_id   uuid NOT NULL REFERENCES oauth_grants ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz -- refresh only: set when rotated; a second use is reuse
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_expires_idx ON oauth_tokens (expires_at);

-- Attribution: an /mcp call made with an OAuth access token records its grant (→ client name).
-- api_key_id set = API key; oauth_grant_id set = OAuth; both null = dashboard chat (session).
ALTER TABLE audit_log ADD COLUMN oauth_grant_id uuid REFERENCES oauth_grants ON DELETE SET NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_one_credential
  CHECK (api_key_id IS NULL OR oauth_grant_id IS NULL);
