// AES-256-GCM sealing of upstream credentials: round-trip, wrong key/AAD, tampering, fresh IVs.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/secretbox.js';

const KEY = randomBytes(32);
const AAD = '6f1c2a52-6b8e-4d1e-9a39-6c4d5a0f2e11';
const SECRET = 'sk-live-very-secret-value';

describe('secretbox', () => {
  it('round-trips and never stores the plaintext', () => {
    const sealed = encrypt(KEY, SECRET, AAD);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(SECRET);
    expect(decrypt(KEY, sealed, AAD)).toBe(SECRET);
  });

  it('uses a fresh random IV on every write', () => {
    const ivs = new Set(
      Array.from({ length: 50 }, () => encrypt(KEY, SECRET, AAD).iv.toString('hex')),
    );
    expect(ivs.size).toBe(50);
  });

  it('fails with the wrong key', () => {
    const sealed = encrypt(KEY, SECRET, AAD);
    expect(() => decrypt(randomBytes(32), sealed, AAD)).toThrow();
  });

  it('fails when the AAD (upstream id) differs', () => {
    const sealed = encrypt(KEY, SECRET, AAD);
    expect(() => decrypt(KEY, sealed, crypto.randomUUID())).toThrow();
  });

  it('fails when the tag, ciphertext or IV is tampered with', () => {
    const sealed = encrypt(KEY, SECRET, AAD);
    const flip = (b: Buffer) => {
      const c = Buffer.from(b);
      c[0]! ^= 1;
      return c;
    };
    expect(() => decrypt(KEY, { ...sealed, tag: flip(sealed.tag) }, AAD)).toThrow();
    expect(() => decrypt(KEY, { ...sealed, tag: sealed.tag.subarray(0, 8) }, AAD)).toThrow();
    expect(() => decrypt(KEY, { ...sealed, ciphertext: flip(sealed.ciphertext) }, AAD)).toThrow();
    expect(() => decrypt(KEY, { ...sealed, iv: flip(sealed.iv) }, AAD)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encrypt(randomBytes(16), SECRET, AAD)).toThrow();
  });
});
