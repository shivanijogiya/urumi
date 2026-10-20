import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const SECRET = 's'.repeat(32);
const valid = {
  WOO_MCP_SHARED_SECRET: SECRET,
  WOO_URL: 'http://wordpress.urumi.svc:80/',
  WOO_USER: 'mcp-bot',
  WOO_APP_PASSWORD: 'abcd efgh ijkl mnop',
};

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(8080);
    expect(config.sharedSecret).toBe(SECRET);
    expect(config.woo).toEqual({
      url: 'http://wordpress.urumi.svc:80',
      user: 'mcp-bot',
      appPassword: 'abcd efgh ijkl mnop',
      forwardedProto: undefined,
      hostHeader: undefined,
    });
  });

  it('reads optional PORT, WOO_FORWARDED_PROTO and WOO_HOST_HEADER', () => {
    const config = loadConfig({
      ...valid,
      PORT: '9000',
      WOO_FORWARDED_PROTO: 'https',
      WOO_HOST_HEADER: 'store.localtest.me',
    });
    expect(config.port).toBe(9000);
    expect(config.woo.forwardedProto).toBe('https');
    expect(config.woo.hostHeader).toBe('store.localtest.me');
  });

  it.each(['WOO_MCP_SHARED_SECRET', 'WOO_URL', 'WOO_USER', 'WOO_APP_PASSWORD'] as const)(
    'names a missing %s',
    (name) => {
      const env: Record<string, string | undefined> = { ...valid };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it('names every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      /WOO_MCP_SHARED_SECRET.*WOO_URL.*WOO_USER.*WOO_APP_PASSWORD/s,
    );
  });

  it('rejects a shared secret shorter than 32 characters without echoing it', () => {
    const short = 'short-secret-value-123';
    const run = () => loadConfig({ ...valid, WOO_MCP_SHARED_SECRET: short });
    expect(run).toThrow(/WOO_MCP_SHARED_SECRET.*32/);
    try {
      run();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(short);
    }
  });

  it('rejects a non-URL WOO_URL and a bad PORT without echoing values', () => {
    const env = { ...valid, WOO_URL: 'not a url with secret-ish text', PORT: 'abc' };
    try {
      loadConfig(env);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('WOO_URL');
      expect(msg).toContain('PORT');
      expect(msg).not.toContain('secret-ish');
      expect(msg).not.toContain(valid.WOO_APP_PASSWORD);
    }
  });

  it('rejects an unsupported WOO_FORWARDED_PROTO', () => {
    expect(() => loadConfig({ ...valid, WOO_FORWARDED_PROTO: 'ftp' })).toThrow(
      'WOO_FORWARDED_PROTO',
    );
  });
});
