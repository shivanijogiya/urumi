// SSRF guard for admin-supplied upstream URLs. Runs on create, on edit, and (#13) before every
// outbound call. Only http/https; the hostname is resolved and every address must be public,
// unless the hostname itself is on the allow-list (UPSTREAM_ALLOWED_HOSTS), which is how in-cluster
// services such as woo-mcp are reached. Errors are generic: no URL, hostname or resolved IP.
//
// Call-time use (#13): connect only to the returned `addresses` (pin them in the HTTP agent's
// lookup) so a DNS answer that changes between this check and the connect cannot reach a blocked
// address. Allow-listed hosts are not resolved here (`addresses` is empty).
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';
import { HttpError } from '../http/errors.js';

export const DNS_TIMEOUT_MS = 3000;

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SsrfOptions {
  /** Normalised UPSTREAM_ALLOWED_HOSTS entries: exact hostnames or `*.suffix`. */
  allow: readonly string[];
  /** DNS resolver; defaults to the system resolver (all addresses). Injected in tests. */
  lookup?: LookupFn;
  timeoutMs?: number;
}

export interface SafeTarget {
  url: URL;
  /** Lowercase, without IPv6 brackets or a trailing dot. */
  hostname: string;
  allowListed: boolean;
  /** Every address the hostname resolved to (all checked); empty for allow-listed hosts. */
  addresses: ResolvedAddress[];
}

/** 400 SSRF_BLOCKED. `reason` is a fixed category for server logs, never sent to the client. */
export class SsrfBlockedError extends HttpError {
  override name = 'SsrfBlockedError';
  constructor(readonly reason: 'url' | 'scheme' | 'userinfo' | 'address') {
    super('SSRF_BLOCKED', 'Upstream URL is not allowed');
  }
}

/** The host did not resolve (or DNS timed out). At call time #13 maps this to UPSTREAM_UNREACHABLE. */
export class HostResolutionError extends HttpError {
  override name = 'HostResolutionError';
  constructor() {
    super('VALIDATION_FAILED', 'Upstream host could not be resolved');
  }
}

const v4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
] as const) {
  v4.addSubnet(net, prefix, 'ipv4');
}

const v6 = new BlockList();
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (embeds an obfuscated IPv4)
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local, incl. fd00:ec2::254 metadata
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  v6.addSubnet(net, prefix, 'ipv6');
}

/** The eight 16-bit words of a valid IPv6 address (zone id already removed). */
function ipv6Words(addr: string): number[] {
  let s = addr;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    // Trailing dotted IPv4 (::ffff:1.2.3.4) → two hex words.
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const headWords = head ? head.split(':') : [];
  const restWords = rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - headWords.length - restWords.length;
  return [...headWords, ...Array<string>(fill).fill('0'), ...restWords].map((w) => parseInt(w, 16));
}

const wordsToV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv4 carried inside an IPv6 address (mapped, NAT64, 6to4), if any. */
function embeddedIPv4(w: number[]): string | null {
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) return wordsToV4(w[6]!, w[7]!); // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return wordsToV4(w[6]!, w[7]!); // NAT64
  if (w[0] === 0x2002) return wordsToV4(w[1]!, w[2]!); // 6to4
  return null;
}

/** True if connecting to `ip` could reach a non-public address. Anything unparseable is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.split('%')[0]!; // drop an IPv6 zone id (fe80::1%eth0)
  if (isIPv4(addr)) return v4.check(addr, 'ipv4');
  if (!isIPv6(addr)) return true;
  const inner = embeddedIPv4(ipv6Words(addr));
  if (inner !== null) return v4.check(inner, 'ipv4');
  return v6.check(addr, 'ipv6');
}

/** `host` (normalised) equals an entry, or is a subdomain of a `*.suffix` entry. */
export function matchesAllowList(host: string, allow: readonly string[]): boolean {
  return allow.some((entry) =>
    entry.startsWith('*.')
      ? host.length > entry.length - 1 && host.endsWith(entry.slice(1))
      : host === entry,
  );
}

const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

async function resolve(hostname: string, lookup: LookupFn, ms: number): Promise<ResolvedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS timeout')), ms);
  });
  try {
    const addresses = await Promise.race([lookup(hostname), timeout]);
    if (addresses.length === 0) throw new Error('no addresses');
    return addresses;
  } catch {
    throw new HostResolutionError();
  } finally {
    clearTimeout(timer);
  }
}

/** Throws SsrfBlockedError / HostResolutionError, or returns the checked target. */
export async function assertSafeUrl(raw: string, opts: SsrfOptions): Promise<SafeTarget> {
  if (!URL.canParse(raw)) throw new SsrfBlockedError('url');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError('scheme');
  // Credentials belong in the encrypted credential field, not in a URL admins can read.
  if (url.username || url.password) throw new SsrfBlockedError('userinfo');

  // WHATWG parsing already canonicalises 127.1, 2130706433, 0x7f000001 … to dotted IPv4.
  const hostname = url.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
  if (matchesAllowList(hostname, opts.allow)) {
    return { url, hostname, allowListed: true, addresses: [] };
  }

  // RFC 6761: always loopback, whatever the resolver says.
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SsrfBlockedError('address');
  }
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await resolve(hostname, opts.lookup ?? systemLookup, opts.timeoutMs ?? DNS_TIMEOUT_MS);
  if (addresses.some((a) => isBlockedAddress(a.address))) throw new SsrfBlockedError('address');
  return { url, hostname, allowListed: false, addresses };
}
