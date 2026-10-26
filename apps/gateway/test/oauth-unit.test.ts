// Pure parts of OAuth (ADR 013): PKCE S256, redirect URI rules, resource and scope checks.
import { describe, expect, it } from 'vitest';
import { randomToken, s256Challenge, verifyPkceS256 } from '../src/oauth/crypto.js';
import {
  parseRedirectSchemes,
  redirectHostOf,
  redirectUriMatches,
  redirectUriProblem,
} from '../src/oauth/redirect.js';
import { normaliseScope, resourceProblem } from '../src/oauth/routes.js';

describe('PKCE (S256 only)', () => {
  // RFC 7636 Appendix B test vector.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('matches the RFC 7636 test vector', () => {
    expect(s256Challenge(verifier)).toBe(challenge);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a wrong, missing, short, long or ill-formed verifier', () => {
    expect(verifyPkceS256(verifier.replace('d', 'e'), challenge)).toBe(false);
    expect(verifyPkceS256(undefined, challenge)).toBe(false);
    expect(verifyPkceS256('a'.repeat(42), s256Challenge('a'.repeat(42)))).toBe(false);
    expect(verifyPkceS256('a'.repeat(129), s256Challenge('a'.repeat(129)))).toBe(false);
    expect(verifyPkceS256(`${'a'.repeat(43)}!`, s256Challenge(`${'a'.repeat(43)}!`))).toBe(false);
  });

  it('never treats the verifier itself as the challenge (no plain method)', () => {
    const v = 'a'.repeat(43);
    expect(verifyPkceS256(v, v)).toBe(false);
  });

  it('random tokens are 43 base64url chars after the prefix and unique', () => {
    const a = randomToken('uat_');
    expect(a).toMatch(/^uat_[A-Za-z0-9_-]{43}$/);
    expect(randomToken('uat_')).not.toBe(a);
  });
});

describe('redirect URI registration', () => {
  it.each([
    'http://localhost:33418/callback',
    'http://127.0.0.1:6274/oauth/callback',
    'http://[::1]:8080/cb',
    'http://localhost/callback',
    'https://vscode.dev/redirect',
    'https://client.example.com/cb?x=1',
  ])('accepts %s', (uri) => expect(redirectUriProblem(uri)).toBeNull());

  it.each([
    ['http://evil.example.com/cb', 'http is allowed only for loopback hosts'],
    ['http://localhost.evil.com/cb', 'http is allowed only for loopback hosts'],
    ['http://127.0.0.2/cb', 'http is allowed only for loopback hosts'],
    ['javascript:alert(1)', 'scheme not allowed'],
    ['data:text/html,hi', 'scheme not allowed'],
    ['file:///etc/passwd', 'scheme not allowed'],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', 'scheme not allowed'],
    ['https://client.example.com/cb#frag', 'must not contain a fragment'],
    ['https://user:pw@client.example.com/cb', 'must not contain userinfo'],
    ['/relative/cb', 'not an absolute URI'],
    ['https://client.example.com/c b', 'not an absolute URI'],
    [`https://e.com/${'a'.repeat(2000)}`, 'not an absolute URI'],
  ])('rejects %s', (uri, why) => expect(redirectUriProblem(uri)).toBe(why));

  it('accepts a private-use scheme only when the operator allows it', () => {
    const cursor = 'cursor://anysphere.cursor-retrieval/oauth/callback';
    expect(redirectUriProblem(cursor, { extraSchemes: ['cursor'] })).toBeNull();
    expect(redirectUriProblem('javascript:alert(1)', { extraSchemes: ['cursor'] })).not.toBeNull();
    expect(parseRedirectSchemes(' Cursor , vscode ')).toEqual(['cursor', 'vscode']);
    expect(() => parseRedirectSchemes('javascript')).toThrow();
    expect(() => parseRedirectSchemes('http')).toThrow();
  });
});

describe('redirect URI matching at /authorize', () => {
  const registered = ['http://127.0.0.1:5000/callback', 'https://app.example.com/cb'];

  it('is exact for https', () => {
    expect(redirectUriMatches(registered, 'https://app.example.com/cb')).toBe(true);
    expect(redirectUriMatches(registered, 'https://app.example.com/cb/')).toBe(false);
    expect(redirectUriMatches(registered, 'https://app.example.com/cb?x=1')).toBe(false);
    expect(redirectUriMatches(registered, 'https://app.example.com.evil.com/cb')).toBe(false);
  });

  it('lets only the port vary for loopback http (RFC 8252 §7.3)', () => {
    expect(redirectUriMatches(registered, 'http://127.0.0.1:61234/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:61234/other')).toBe(false);
    expect(redirectUriMatches(registered, 'http://localhost:5000/callback')).toBe(false);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:5000/callback#x')).toBe(false);
  });

  it('shows host:port on the consent page', () => {
    expect(redirectHostOf('http://127.0.0.1:5000/callback')).toBe('127.0.0.1:5000');
    expect(redirectHostOf('https://app.example.com/cb')).toBe('app.example.com');
  });
});

describe('resource indicator (RFC 8707) and scope', () => {
  const issuer = 'http://app.localtest.me';
  it('accepts the gateway MCP URL (or none)', () => {
    expect(resourceProblem(issuer, undefined)).toBeNull();
    expect(resourceProblem(issuer, 'http://app.localtest.me/mcp')).toBeNull();
    expect(resourceProblem(issuer, 'http://app.localtest.me/mcp/')).toBeNull();
    expect(resourceProblem(issuer, 'http://app.localtest.me/mcp?mode=discovery')).toBeNull();
  });
  it.each([
    'https://app.localtest.me/mcp',
    'http://app.localtest.me:8080/mcp',
    'http://evil.example.com/mcp',
    'http://app.localtest.me/',
    'http://app.localtest.me/mcp/other',
    'http://app.localtest.me/mcp#x',
    'not a url',
  ])('rejects %s', (r) => expect(resourceProblem(issuer, r)).not.toBeNull());

  it('supports only the mcp scope', () => {
    expect(normaliseScope(undefined)).toBe('mcp');
    expect(normaliseScope('mcp mcp')).toBe('mcp');
    expect(normaliseScope('mcp admin')).toBeNull();
    expect(normaliseScope('openid')).toBeNull();
  });
});
