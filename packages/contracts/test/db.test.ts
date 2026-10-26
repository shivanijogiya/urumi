import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db.js';
import { SLUG_RE } from '../src/index.js';

const sql = readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');

describe('001_init.sql', () => {
  it.each(['users', 'sessions', 'api_keys', 'upstreams', 'audit_log'])('creates %s', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
  });

  it('declares key constraints', () => {
    expect(sql).toContain('CHECK (email = lower(email))');
    expect(sql).toContain("CHECK (role IN ('admin', 'member'))");
    expect(sql).toMatch(/key_hash\s+bytea NOT NULL UNIQUE/);
    expect(sql).toContain(`CHECK (slug ~ '${SLUG_RE.source}')`);
    expect(sql).toContain("CHECK (outcome IN ('ok', 'error', 'timeout', 'denied'))");
    expect(sql).toContain('CHECK (duration_ms >= 0)');
    expect(sql).toMatch(/ON audit_log \(user_id, started_at DESC\)/);
  });

  it('requires encrypted credential parts iff a credential type is set', () => {
    expect(sql).toContain('CONSTRAINT upstreams_credential_complete CHECK');
  });

  it('does not store tool arguments or results', () => {
    const auditTable = sql.slice(sql.indexOf('CREATE TABLE audit_log'));
    expect(auditTable).not.toMatch(/\b(arguments|args|result)\s+(jsonb|text)/i);
  });
});

describe('003_scaling.sql', () => {
  const scaling = readFileSync(join(MIGRATIONS_DIR, '003_scaling.sql'), 'utf8');
  it('adds the shared rate-limit buckets and leases, and the rate_limited outcome', () => {
    expect(scaling).toMatch(/CREATE TABLE rate_limit_buckets \(/);
    expect(scaling).toMatch(/CREATE TABLE gateway_leases \(/);
    expect(scaling).toContain(
      "CHECK (outcome IN ('ok', 'error', 'timeout', 'denied', 'rate_limited'))",
    );
  });
});

describe('004_observability.sql', () => {
  const obs = readFileSync(join(MIGRATIONS_DIR, '004_observability.sql'), 'utf8');
  it('adds last_ok_at, a bounded error_detail and the per-server audit index (additive only)', () => {
    expect(obs).toContain('ALTER TABLE upstreams ADD COLUMN last_ok_at timestamptz');
    expect(obs).toContain('ALTER TABLE audit_log ADD COLUMN error_detail text');
    expect(obs).toMatch(/ON audit_log \(server_slug, started_at DESC\)/);
    expect(obs).not.toMatch(/\bDROP\b/);
  });
});

describe('005_oauth.sql', () => {
  const oauth = readFileSync(join(MIGRATIONS_DIR, '005_oauth.sql'), 'utf8');
  it.each(['oauth_clients', 'oauth_auth_requests', 'oauth_grants', 'oauth_codes', 'oauth_tokens'])(
    'creates %s',
    (table) => expect(oauth).toMatch(new RegExp(`CREATE TABLE ${table} \\(`)),
  );
  it('stores codes and tokens only as hashes', () => {
    expect(oauth).toMatch(/code_hash\s+bytea PRIMARY KEY/);
    expect(oauth).toMatch(/token_hash bytea PRIMARY KEY/);
    expect(oauth).not.toMatch(/\b(access_token|refresh_token|code|client_secret)\s+text/);
  });
  it('attributes audit rows to at most one credential', () => {
    expect(oauth).toContain('CHECK (api_key_id IS NULL OR oauth_grant_id IS NULL)');
  });
});

describe('006_hosted.sql', () => {
  const hosted = readFileSync(join(MIGRATIONS_DIR, '006_hosted.sql'), 'utf8');
  it('adds hosted_servers (1:1 with upstreams) and the upstreams.hosted flag, additive only', () => {
    expect(hosted).toContain(
      'ALTER TABLE upstreams ADD COLUMN hosted boolean NOT NULL DEFAULT false',
    );
    expect(hosted).toMatch(/CREATE TABLE hosted_servers \(/);
    expect(hosted).toMatch(/id\s+uuid PRIMARY KEY REFERENCES upstreams ON DELETE CASCADE/);
    expect(hosted).not.toMatch(/\bDROP\b/);
  });
  it('stores env values only sealed (no plaintext column)', () => {
    expect(hosted).toMatch(/env_ciphertext\s+bytea/);
    expect(hosted).not.toMatch(/env_values|env_plain|env\s+(jsonb|text)\b/);
  });
});

describe('007_stores.sql', () => {
  const stores = readFileSync(join(MIGRATIONS_DIR, '007_stores.sql'), 'utf8');
  it('adds stores (1:1 with upstreams) and the upstreams.store flag, additive only', () => {
    expect(stores).toContain(
      'ALTER TABLE upstreams ADD COLUMN store boolean NOT NULL DEFAULT false',
    );
    expect(stores).toMatch(/CREATE TABLE stores \(/);
    expect(stores).toMatch(/id\s+uuid PRIMARY KEY REFERENCES upstreams ON DELETE CASCADE/);
    expect(stores).not.toMatch(/\bDROP\b/);
  });
  it('stores no password or secret column', () => {
    const columns = stores.slice(stores.indexOf('CREATE TABLE stores'));
    expect(columns).not.toMatch(/password|secret|ciphertext/i);
  });
});
