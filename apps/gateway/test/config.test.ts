import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const ENC_KEY = Buffer.alloc(32, 1).toString('base64');
const SEED_PASSWORD = 'seed-password-value-123';
const PG_PASSWORD = 'pg-password-value-456';

const valid = {
  PGHOST: 'db',
  PGUSER: 'gateway',
  PGPASSWORD: PG_PASSWORD,
  PGDATABASE: 'gateway',
  SEED_ADMIN_EMAIL: 'Admin@Example.com',
  SEED_ADMIN_PASSWORD: SEED_PASSWORD,
  GATEWAY_ENC_KEY: ENC_KEY,
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
    expect(c.publicOrigin).toBe('http://app.localtest.me');
    expect(c.cookieSecure).toBe(false);
    // In-cluster the gateway sits behind Traefik, which sets X-Forwarded-For.
    expect(c.trustProxy).toBe(true);
  });

  it('leaves canary track and fault injection off by default', () => {
    const c = loadConfig(valid);
    expect(c.track).toBeNull();
    expect(c.faultInject).toEqual({ errorRate: 0, latencyMs: 0 });
  });

  it('parses TRACK, FAULT_INJECT_ERROR_RATE and FAULT_INJECT_LATENCY_MS', () => {
    const c = loadConfig({
      ...valid,
      TRACK: 'canary',
      FAULT_INJECT_ERROR_RATE: '0.5',
      FAULT_INJECT_LATENCY_MS: '250',
    });
    expect(c.track).toBe('canary');
    expect(c.faultInject).toEqual({ errorRate: 0.5, latencyMs: 250 });
    expect(loadConfig({ ...valid, FAULT_INJECT_ERROR_RATE: '' }).faultInject.errorRate).toBe(0);
    for (const [name, bad] of [
      ['TRACK', 'Canary!'],
      ['FAULT_INJECT_ERROR_RATE', '1.5'],
      ['FAULT_INJECT_ERROR_RATE', '-0.1'],
      ['FAULT_INJECT_ERROR_RATE', 'half'],
      ['FAULT_INJECT_LATENCY_MS', '-1'],
      ['FAULT_INJECT_LATENCY_MS', '1.5'],
      ['FAULT_INJECT_LATENCY_MS', '60000'],
    ] as const) {
      expect(errorFor({ ...valid, [name]: bad }).message).toContain(name);
    }
  });

  it('parses TRUST_PROXY as true, false, or a hop count', () => {
    expect(loadConfig({ ...valid, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...valid, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...valid, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    for (const bad of ['yes', '-1', '1.5']) {
      expect(errorFor({ ...valid, TRUST_PROXY: bad }).message).toContain('TRUST_PROXY');
    }
  });

  it('honours PUBLIC_ORIGIN and COOKIE_SECURE', () => {
    const c = loadConfig({
      ...valid,
      PUBLIC_ORIGIN: 'https://app.example.com/',
      COOKIE_SECURE: 'true',
    });
    expect(c.publicOrigin).toBe('https://app.example.com');
    expect(c.cookieSecure).toBe(true);
    expect(loadConfig({ ...valid, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('rejects a PUBLIC_ORIGIN that is not a bare http(s) origin, and a non-boolean COOKIE_SECURE', () => {
    for (const origin of [
      'app.example.com',
      'ftp://app.example.com',
      'https://app.example.com/x',
    ]) {
      expect(errorFor({ ...valid, PUBLIC_ORIGIN: origin }).message).toContain('PUBLIC_ORIGIN');
    }
    expect(errorFor({ ...valid, COOKIE_SECURE: 'yes' }).message).toContain('COOKIE_SECURE');
  });

  it('parses UPSTREAM_ALLOWED_HOSTS as exact hostnames or *.suffix (default empty)', () => {
    expect(loadConfig(valid).upstreamAllowedHosts).toEqual([]);
    expect(loadConfig({ ...valid, UPSTREAM_ALLOWED_HOSTS: '' }).upstreamAllowedHosts).toEqual([]);
    expect(
      loadConfig({
        ...valid,
        UPSTREAM_ALLOWED_HOSTS: ' *.Urumi.svc.cluster.local , woo-mcp.internal.,,api.example.com',
      }).upstreamAllowedHosts,
    ).toEqual(['*.urumi.svc.cluster.local', 'woo-mcp.internal', 'api.example.com']);
  });

  it('rejects malformed or over-broad UPSTREAM_ALLOWED_HOSTS entries', () => {
    for (const bad of [
      '*',
      '*.local',
      '*.com',
      'a.*.example.com',
      '*example.com',
      'http://example.com',
      'example.com:8080',
      'exa mple.com',
      '-bad.example.com',
    ]) {
      expect(errorFor({ ...valid, UPSTREAM_ALLOWED_HOSTS: bad }).message, bad).toContain(
        'UPSTREAM_ALLOWED_HOSTS',
      );
    }
  });

  it('chat: ANTHROPIC_API_KEY optional (null when unset or empty), CHAT_MODEL defaulted', () => {
    expect(loadConfig(valid)).toMatchObject({
      anthropicApiKey: null,
      chatModel: 'claude-sonnet-5-5',
    });
    expect(loadConfig({ ...valid, ANTHROPIC_API_KEY: '' }).anthropicApiKey).toBeNull();
    const c = loadConfig({ ...valid, ANTHROPIC_API_KEY: 'sk-ant-x', CHAT_MODEL: 'claude-x-1' });
    expect(c).toMatchObject({ anthropicApiKey: 'sk-ant-x', chatModel: 'claude-x-1' });
    expect(loadConfig({ ...valid, CHAT_MODEL: '' }).chatModel).toBe('claude-sonnet-5-5');
    expect(errorFor({ ...valid, CHAT_MODEL: 'bad model' }).message).toContain('CHAT_MODEL');
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

  it('does not need GATEWAY_SESSION_SECRET and ignores a leftover one (sessions are DB tokens)', () => {
    expect(() => loadConfig(valid)).not.toThrow();
    const c = loadConfig({ ...valid, GATEWAY_SESSION_SECRET: 'short' });
    expect(c).not.toHaveProperty('sessionSecret');
    expect(JSON.stringify(c)).not.toContain('short');
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
      SEED_ADMIN_EMAIL: 'not-an-email-secret',
    });
    for (const value of ['tiny-secret', badKey, 'not-an-email-secret', PG_PASSWORD]) {
      expect(err.message).not.toContain(value);
    }
  });
});

describe('loadConfig: scaling (ADR 010)', () => {
  it('defaults the /mcp rate limits and takes the pod name for the health lease', () => {
    const c = loadConfig({ ...valid, POD_NAME: 'urumi-gateway-abc12' });
    expect(c.mcpRateLimits).toEqual({
      perKey: { perMinute: 120, burst: 60 },
      perUser: { perMinute: 240, burst: 120 },
    });
    expect(c.podName).toBe('urumi-gateway-abc12');
    expect(loadConfig(valid).podName.length).toBeGreaterThan(0); // hostname fallback
  });

  it('reads the limits; 0 turns a limit off; garbage is rejected by name', () => {
    const c = loadConfig({
      ...valid,
      MCP_RATE_LIMIT_KEY_PER_MIN: '600',
      MCP_RATE_LIMIT_KEY_BURST: '0',
      MCP_RATE_LIMIT_USER_PER_MIN: '900',
      MCP_RATE_LIMIT_USER_BURST: '300',
    });
    expect(c.mcpRateLimits.perKey).toEqual({ perMinute: 600, burst: 0 });
    expect(c.mcpRateLimits.perUser).toEqual({ perMinute: 900, burst: 300 });
    expect(errorFor({ ...valid, MCP_RATE_LIMIT_KEY_BURST: '-1' }).message).toContain(
      'MCP_RATE_LIMIT_KEY_BURST',
    );
    expect(errorFor({ ...valid, POD_NAME: 'bad name!' }).message).toContain('POD_NAME');
  });
});

describe('loadConfig: metrics (ADR 011)', () => {
  it('serves /metrics on 9464 by default; 0 turns it off', () => {
    expect(loadConfig(valid).metricsPort).toBe(9464);
    expect(loadConfig({ ...valid, METRICS_PORT: '0' }).metricsPort).toBe(0);
    expect(errorFor({ ...valid, METRICS_PORT: '70000' }).message).toContain('METRICS_PORT');
  });
});

describe('loadConfig: discovery (ADR 012)', () => {
  it('switches chat to discovery above 40 tools by default; configurable; 0 = always', () => {
    expect(loadConfig(valid).chatDiscoveryThreshold).toBe(40);
    expect(loadConfig({ ...valid, CHAT_DISCOVERY_THRESHOLD: '0' }).chatDiscoveryThreshold).toBe(0);
    expect(errorFor({ ...valid, CHAT_DISCOVERY_THRESHOLD: 'many' }).message).toContain(
      'CHAT_DISCOVERY_THRESHOLD',
    );
  });
});
