// Row types as returned by node-postgres (timestamptz → Date, bytea → Buffer, bigint → string).
// Types only. bytea is typed as Uint8Array (Buffer's base class) so the browser bundle needs no Node types.
export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  password_hash: string;
  created_at: Date;
  disabled_at: Date | null;
}

export interface SessionRow {
  id: string; // sha256 hex of the cookie token
  user_id: string;
  created_at: Date;
  expires_at: Date;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: Uint8Array;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface UpstreamRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  credential_type: 'none' | 'bearer' | 'header';
  credential_header_name: string | null;
  credential_ciphertext: Uint8Array | null;
  credential_iv: Uint8Array | null;
  credential_tag: Uint8Array | null;
  status: 'unknown' | 'up' | 'down';
  last_error: string | null;
  last_checked_at: Date | null;
  /** Last successful health check (004_observability.sql). */
  last_ok_at: Date | null;
  /** Created for a hosted server (006_hosted.sql): managed via /api/hosted-servers only. */
  hosted: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A hosted MCP server (006_hosted.sql, ADR 014). id = its upstream row's id. */
export interface HostedServerRow {
  id: string;
  image: string;
  image_digest: string | null;
  port: number;
  mcp_path: string;
  preset: 'small' | 'medium';
  egress: boolean;
  env_keys: string[];
  env_ciphertext: Uint8Array | null;
  env_iv: Uint8Array | null;
  env_tag: Uint8Array | null;
  desired_state: 'present' | 'absent';
  phase: 'deploying' | 'connected' | 'unreachable' | 'failed' | 'deleting';
  reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_reconciled_at: Date | null;
}

export interface AuditLogRow {
  id: string;
  user_id: string;
  api_key_id: string | null;
  source: 'mcp' | 'chat';
  server_slug: string;
  tool: string;
  started_at: Date;
  duration_ms: number;
  outcome: 'ok' | 'error' | 'timeout' | 'denied' | 'rate_limited';
  error_code: string | null;
  /** Fixed-vocabulary failure detail (004_observability.sql); null for ok. */
  error_detail: string | null;
  /** OAuth grant of an /mcp call made with an access token (005_oauth.sql); else null. */
  oauth_grant_id: string | null;
}

/** 005_oauth.sql (ADR 013). Hash columns never leave the gateway's repo modules. */
export interface OAuthClientRow {
  id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  secret_hash: Buffer | null;
  created_at: Date;
}

export interface OAuthGrantRow {
  id: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string;
  created_at: Date;
  activated_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: 'user' | 'admin' | 'client' | 'refresh_reuse' | 'code_reuse' | null;
}
