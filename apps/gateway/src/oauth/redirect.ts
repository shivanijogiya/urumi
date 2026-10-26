// Redirect URI rules (ADR 013, OAuth 2.1 §2.3.1 / §7.5, RFC 8252 §7.3).
//
// Registration accepts only:
//   - https://… (any host), and
//   - http:// on a loopback host: localhost, 127.0.0.1 or [::1] (native clients: Claude Code,
//     Inspector), any port;
//   - a private-use scheme only if the operator listed it (OAUTH_REDIRECT_SCHEMES, e.g. `cursor`).
// Never: other http hosts, javascript:/data:/file:, userinfo, fragments, or over-long values.
//
// /authorize compares the requested URI with the registered ones by exact string, except that
// for a loopback http URI the port may differ (RFC 8252 §7.3: native apps pick a free port).
export const MAX_REDIRECT_URI_LENGTH = 2000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** RFC 3986 scheme; a private-use one must be explicitly allowed. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const NEVER_SCHEMES = new Set([
  'javascript',
  'data',
  'file',
  'vbscript',
  'blob',
  'about',
  'ws',
  'wss',
]);

export interface RedirectPolicy {
  /** Extra private-use schemes (lowercase, without ':'), e.g. ['cursor']. Default none. */
  extraSchemes?: readonly string[];
}

export function parseRedirectSchemes(raw: string): string[] {
  const out = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const s of out) {
    if (!SCHEME_RE.test(s) || NEVER_SCHEMES.has(s) || s === 'http' || s === 'https') {
      throw new Error('OAUTH_REDIRECT_SCHEMES: invalid scheme');
    }
  }
  return out;
}

function parse(uri: string): URL | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) {
    return null;
  }
  // No whitespace or control characters anywhere (URL() would silently strip some of them).
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\s\0-\x1f\x7f]/.test(uri)) return null;
  if (!URL.canParse(uri)) return null;
  return new URL(uri);
}

export function isLoopbackHttp(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/** Null if `uri` may be registered; otherwise the reason (for the invalid_redirect_uri error). */
export function redirectUriProblem(uri: string, policy: RedirectPolicy = {}): string | null {
  const u = parse(uri);
  if (!u) return 'not an absolute URI';
  if (u.hash || uri.includes('#')) return 'must not contain a fragment';
  if (u.username || u.password) return 'must not contain userinfo';
  const scheme = u.protocol.slice(0, -1);
  if (scheme === 'https') return u.hostname ? null : 'https URI needs a host';
  if (scheme === 'http')
    return isLoopbackHttp(u) ? null : 'http is allowed only for loopback hosts';
  if (NEVER_SCHEMES.has(scheme)) return 'scheme not allowed';
  if (policy.extraSchemes?.includes(scheme)) return null;
  return 'scheme not allowed';
}

/** True if `requested` is one of `registered` (loopback http: any port). */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  const req = parse(requested);
  if (!req) return false;
  for (const r of registered) {
    if (r === requested) return true;
    const reg = parse(r);
    if (reg && isLoopbackHttp(reg) && isLoopbackHttp(req)) {
      if (
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search &&
        !req.hash
      ) {
        return true;
      }
    }
  }
  return false;
}

/** `host[:port]` shown on the consent page, or the scheme for a private-use URI. */
export function redirectHostOf(uri: string): string {
  const u = parse(uri);
  if (!u) return '';
  return u.host || `${u.protocol}//`;
}

/** Appends OAuth response parameters to a (validated, registered) redirect URI. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
