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
