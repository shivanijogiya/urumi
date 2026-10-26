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
  created_at: Date;
  updated_at: Date;
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
}
