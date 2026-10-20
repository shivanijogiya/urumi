// SSRF guard: scheme check, resolved-address block list (incl. IPv4-mapped/embedded IPv6), allow-list.
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/http/errors.js';
import {
  assertSafeUrl,
  isBlockedAddress,
  matchesAllowList,
  type LookupFn,
} from '../src/upstreams/ssrf.js';

const DNS: Record<string, string[]> = {
  'internal.example.com': ['10.0.0.5'],
  'mixed.example.com': ['93.184.216.34', '192.168.1.10'],
  'public.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  'metadata.example.com': ['169.254.169.254'],
  'v6-mapped.example.com': ['::ffff:10.1.2.3'],
  localhost: ['127.0.0.1', '::1'],
  'woo-mcp.urumi.svc.cluster.local': ['10.43.12.7'],
  'evil.svc.cluster.local.attacker.com': ['10.43.12.7'],
};

/** Stub resolver: the table above, ENOTFOUND for anything else. */
const lookup: LookupFn = async (host) => {
  const addrs = DNS[host];
  if (!addrs)
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const ALLOW = ['*.urumi.svc.cluster.local', 'exact.internal'];

async function outcome(url: string, allow: readonly string[] = ALLOW): Promise<string> {
  try {
    await assertSafeUrl(url, { allow, lookup });
    return 'allowed';
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).code;
  }
}

describe('assertSafeUrl', () => {
  it.each([
    // scheme
    ['file:///etc/passwd', 'SSRF_BLOCKED'],
    ['ftp://public.example.com/', 'SSRF_BLOCKED'],
    ['gopher://public.example.com/', 'SSRF_BLOCKED'],
    ['not a url', 'SSRF_BLOCKED'],
    ['http://user:pass@public.example.com/', 'SSRF_BLOCKED'],
    // loopback in every spelling the URL parser normalises
    ['http://localhost/', 'SSRF_BLOCKED'],
    ['http://LOCALHOST./', 'SSRF_BLOCKED'],
    ['http://app.localhost/', 'SSRF_BLOCKED'],
    ['http://127.0.0.1/', 'SSRF_BLOCKED'],
    ['http://127.1/', 'SSRF_BLOCKED'],
    ['http://2130706433/', 'SSRF_BLOCKED'],
    ['http://0x7f000001/', 'SSRF_BLOCKED'],
    ['http://[::1]/', 'SSRF_BLOCKED'],
    ['http://[::]/', 'SSRF_BLOCKED'],
    ['http://0.0.0.0/', 'SSRF_BLOCKED'],
    // IPv4-mapped / embedded IPv6
    ['http://[::ffff:127.0.0.1]/', 'SSRF_BLOCKED'],
    ['http://[::ffff:7f00:1]/', 'SSRF_BLOCKED'],
    ['http://[::ffff:169.254.169.254]/', 'SSRF_BLOCKED'],
    ['http://[64:ff9b::10.0.0.1]/', 'SSRF_BLOCKED'],
    ['http://[2002:a00:1::]/', 'SSRF_BLOCKED'],
    // metadata, link-local, private, CGNAT, multicast
    ['http://169.254.169.254/latest/meta-data/', 'SSRF_BLOCKED'],
    ['http://[fd00:ec2::254]/', 'SSRF_BLOCKED'],
    ['http://[fe80::1]/', 'SSRF_BLOCKED'],
    ['http://10.1.2.3/', 'SSRF_BLOCKED'],
    ['http://172.16.0.1/', 'SSRF_BLOCKED'],
    ['http://172.31.255.255/', 'SSRF_BLOCKED'],
    ['http://192.168.0.1/', 'SSRF_BLOCKED'],
    ['http://100.64.0.1/', 'SSRF_BLOCKED'],
    ['http://224.0.0.1/', 'SSRF_BLOCKED'],
    ['http://255.255.255.255/', 'SSRF_BLOCKED'],
    ['http://[ff02::1]/', 'SSRF_BLOCKED'],
    ['http://[fc00::1]/', 'SSRF_BLOCKED'],
    // hostnames resolving to blocked addresses (any one blocked address blocks)
    ['http://internal.example.com/', 'SSRF_BLOCKED'],
    ['https://mixed.example.com/', 'SSRF_BLOCKED'],
    ['http://metadata.example.com/', 'SSRF_BLOCKED'],
    ['http://v6-mapped.example.com/', 'SSRF_BLOCKED'],
    // allowed
    ['http://93.184.216.34/', 'allowed'],
    ['http://172.32.0.1/', 'allowed'],
    ['https://public.example.com/mcp', 'allowed'],
    ['https://[2606:2800:220:1:248:1893:25c8:1946]/', 'allowed'],
    ['http://woo-mcp.urumi.svc.cluster.local:8080/mcp', 'allowed'],
    ['http://WOO-MCP.urumi.svc.cluster.local./mcp', 'allowed'],
    ['http://exact.internal/', 'allowed'],
    // allow-list is exact / suffix, never substring
    ['http://evil.svc.cluster.local.attacker.com/', 'SSRF_BLOCKED'],
    ['http://urumi.svc.cluster.local/', 'VALIDATION_FAILED'],
    ['http://sub.exact.internal/', 'VALIDATION_FAILED'],
    // unresolvable
    ['http://nope.example.com/', 'VALIDATION_FAILED'],
  ])('%s → %s', async (url, expected) => {
    expect(await outcome(url)).toBe(expected);
  });

  it('blocks private hosts when the allow-list is empty', async () => {
    expect(await outcome('http://woo-mcp.urumi.svc.cluster.local/', [])).toBe('SSRF_BLOCKED');
  });

  it('allow-lists the hostname, not an IP literal it resolves to', async () => {
    expect(await outcome('http://10.43.12.7/')).toBe('SSRF_BLOCKED');
  });

  it('returns the resolved addresses so a caller can pin the connection', async () => {
    const target = await assertSafeUrl('https://public.example.com/mcp', { allow: [], lookup });
    expect(target.url.hostname).toBe('public.example.com');
    expect(target.allowListed).toBe(false);
    expect(target.addresses.map((a) => a.address)).toEqual(DNS['public.example.com']);
  });

  it('uses a generic message that names neither the URL nor the resolved IP', async () => {
    const err = await assertSafeUrl('http://internal.example.com/x', { allow: [], lookup }).catch(
      (e: HttpError) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).not.toMatch(/10\.0\.0\.5|internal\.example\.com/);
  });

  it('does not resolve IP literals', async () => {
    const spy = vi.fn(lookup);
    await assertSafeUrl('http://93.184.216.34/', { allow: [], lookup: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks localhost with the default (system) resolver too', async () => {
    await expect(assertSafeUrl('http://localhost:9/', { allow: [] })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });

  it('times out a hanging resolver', async () => {
    const hang: LookupFn = () => new Promise(() => undefined);
    await expect(
      assertSafeUrl('http://slow.example.com/', { allow: [], lookup: hang, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:c0a8:101', true],
    ['::127.0.0.1', true],
    ['fe80::1%eth0', true],
    ['2001:db8::1', true],
    ['8.8.8.8', false],
    ['::ffff:8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    ['not-an-ip', true],
  ])('%s → %s', (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });
});

describe('matchesAllowList', () => {
  it('matches exact names and *.suffix subdomains only', () => {
    expect(matchesAllowList('a.urumi.svc.cluster.local', ALLOW)).toBe(true);
    expect(matchesAllowList('a.b.urumi.svc.cluster.local', ALLOW)).toBe(true);
    expect(matchesAllowList('urumi.svc.cluster.local', ALLOW)).toBe(false);
    expect(matchesAllowList('xurumi.svc.cluster.local', ALLOW)).toBe(false);
    expect(matchesAllowList('exact.internal', ALLOW)).toBe(true);
    expect(matchesAllowList('exact.internal.evil.com', ALLOW)).toBe(false);
  });
});
