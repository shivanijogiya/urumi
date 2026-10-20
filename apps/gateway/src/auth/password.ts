// Password hashing with scrypt (node:crypto). Stored format: scrypt$N$r$p$saltB64$hashB64.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Caps for parameters read back from the database, so a corrupted row cannot make verify
// allocate gigabytes. 128 * N * r bytes is scrypt's memory use.
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  const maxmem = 128 * opts.N! * opts.r! * 2;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const INT = /^[1-9][0-9]{0,9}$/;

/** True only if `stored` is a well-formed scrypt hash of `password`. Never throws on bad input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nS, rS, pS, saltS, hashS] = parts as [string, string, string, string, string, string];
  if (!INT.test(nS) || !INT.test(rS) || !INT.test(pS) || !B64.test(saltS) || !B64.test(hashS)) {
    return false;
  }
  const n = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || r > MAX_R || p > MAX_P) return false;
  const salt = Buffer.from(saltS, 'base64');
  const expected = Buffer.from(hashS, 'base64');
  if (salt.length < SALT_BYTES || expected.length !== KEY_BYTES) return false;
  try {
    const actual = await derive(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
