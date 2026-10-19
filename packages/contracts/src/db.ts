import { fileURLToPath } from 'node:url';

/** Directory of numbered `NNN_name.sql` migrations, applied in order by the gateway's runner. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../sql/', import.meta.url));

// Row types as returned by node-postgres (timestamptz → Date, bytea → Buffer, bigint → string).
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
  key_hash: Buffer;
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
  credential_ciphertext: Buffer | null;
  credential_iv: Buffer | null;
  credential_tag: Buffer | null;
  status: 'unknown' | 'up' | 'down';
  last_error: string | null;
  last_checked_at: Date | null;
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
  outcome: 'ok' | 'error' | 'timeout' | 'denied';
  error_code: string | null;
}
