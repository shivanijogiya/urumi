import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const ENC_KEY = Buffer.alloc(32, 1).toString('base64');
const SEED_PASSWORD = 'seed-password-value-123';
const PG_PASSWORD = 'pg-password-value-456';
const SESSION_SECRET = 's'.repeat(32);

const valid = {
  PGHOST: 'db',
  PGUSER: 'gateway',
  PGPASSWORD: PG_PASSWORD,
  PGDATABASE: 'gateway',
  SEED_ADMIN_EMAIL: 'Admin@Example.com',
  SEED_ADMIN_PASSWORD: SEED_PASSWORD,
  GATEWAY_ENC_KEY: ENC_KEY,
  GATEWAY_SESSION_SECRET: SESSION_SECRET,
};

function errorFor(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig(valid);
    expect(c.port).toBe(8080);
    expect(c.db).toEqual({
      host: 'db',
      port: 5432,
      user: 'gateway',
      password: PG_PASSWORD,
      database: 'gateway',
    });
    expect(c.migrationsDir).toBe(MIGRATIONS_DIR);
    expect(c.seedAdmin).toEqual({ email: 'admin@example.com', password: SEED_PASSWORD });
    expect(c.encKey).toHaveLength(32);
    expect(c.sessionSecret).toBe(SESSION_SECRET);
  });

  it('honours PORT, PGPORT and MIGRATIONS_DIR', () => {
    const c = loadConfig({
      ...valid,
      PORT: '9000',
      PGPORT: '6543',
      MIGRATIONS_DIR: '/app/migrations',
    });
    expect(c.port).toBe(9000);
    expect(c.db).toMatchObject({ port: 6543 });
    expect(c.migrationsDir).toBe('/app/migrations');
  });

  it('accepts DATABASE_URL instead of the PG* variables', () => {
    const url = 'postgres://gateway:x@db:5432/gateway';
    const env = {
      ...valid,
      PGHOST: undefined,
      PGUSER: undefined,
      PGPASSWORD: undefined,
      PGDATABASE: undefined,
      DATABASE_URL: url,
    };
    expect(loadConfig(env).db).toEqual({ connectionString: url });
  });

  it.each([
    'SEED_ADMIN_EMAIL',
    'SEED_ADMIN_PASSWORD',
    'GATEWAY_ENC_KEY',
    'GATEWAY_SESSION_SECRET',
    'PGHOST',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
  ])('fails fast naming a missing %s', (name) => {
    const err = errorFor({ ...valid, [name]: undefined });
    expect(err.message).toContain(name);
  });

  it('rejects a seed password shorter than 12 characters', () => {
    expect(errorFor({ ...valid, SEED_ADMIN_PASSWORD: 'short-pw-11' }).message).toContain(
      'SEED_ADMIN_PASSWORD',
    );
  });

  it('rejects an encryption key that is not exactly 32 bytes of base64', () => {
    for (const key of [
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      'not base64 !!',
    ]) {
      expect(errorFor({ ...valid, GATEWAY_ENC_KEY: key }).message).toContain('GATEWAY_ENC_KEY');
    }
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(errorFor({ ...valid, GATEWAY_SESSION_SECRET: 'x'.repeat(31) }).message).toContain(
      'GATEWAY_SESSION_SECRET',
    );
  });

  it('rejects an invalid email and port', () => {
    expect(errorFor({ ...valid, SEED_ADMIN_EMAIL: 'nope' }).message).toContain('SEED_ADMIN_EMAIL');
    expect(errorFor({ ...valid, PORT: '70000' }).message).toContain('PORT');
  });

  it('never puts a value in the error message', () => {
    const badKey = 'secret-looking-but-invalid-key';
    const err = errorFor({
      ...valid,
      SEED_ADMIN_PASSWORD: 'tiny-secret',
      GATEWAY_ENC_KEY: badKey,
      GATEWAY_SESSION_SECRET: 'short-session-secret',
      SEED_ADMIN_EMAIL: 'not-an-email-secret',
    });
    for (const value of [
      'tiny-secret',
      badKey,
      'short-session-secret',
      'not-an-email-secret',
      PG_PASSWORD,
    ]) {
      expect(err.message).not.toContain(value);
    }
  });
});
