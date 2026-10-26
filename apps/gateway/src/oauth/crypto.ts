// Random opaque values and their hashes (ADR 013). Like API keys: 32 random bytes, base64url, and
// only sha256 is stored. PKCE: S256 only (RFC 7636 §4.2); `plain` is never accepted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** `prefix` + base64url(32 random bytes): 43 characters after the prefix. */
export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function sha256hex(value: string): string {
  return sha256(value).toString('hex');
}

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url(sha256(verifier)) without padding is always 43 characters. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** True iff `verifier` is well formed and base64url(sha256(verifier)) equals `challenge`. */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !CODE_VERIFIER_RE.test(verifier)) return false;
  if (!CODE_CHALLENGE_RE.test(challenge)) return false;
  return safeEqual(s256Challenge(verifier), challenge);
}

/** Constant-time comparison of two strings (false on different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
