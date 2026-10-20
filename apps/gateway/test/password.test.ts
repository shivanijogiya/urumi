import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

const PW = 'correct horse battery staple';

describe('password hashing (scrypt)', () => {
  it('uses the format scrypt$N$r$p$saltB64$hashB64 with N=16384 r=8 p=1, 16-byte salt, 64-byte key', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    const [scheme, n, r, p, salt, hash] = parts;
    expect([scheme, n, r, p]).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(hash!, 'base64')).toHaveLength(64);
    expect(stored).not.toContain(PW);
  });

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword(PW)).not.toBe(await hashPassword(PW));
  });

  it('verifies the correct password', async () => {
    expect(await verifyPassword(PW, await hashPassword(PW))).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword(PW);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('rejects a tampered hash or salt', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split('$');
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString('base64');
    };
    const badHash = [...parts.slice(0, 5), flip(parts[5]!)].join('$');
    const badSalt = [...parts.slice(0, 4), flip(parts[4]!), parts[5]].join('$');
    expect(await verifyPassword(PW, badHash)).toBe(false);
    expect(await verifyPassword(PW, badSalt)).toBe(false);
  });

  it('rejects malformed or unsupported stored values without throwing', async () => {
    const stored = await hashPassword(PW);
    const [, , , , salt, hash] = stored.split('$');
    for (const bad of [
      '',
      'plain-text',
      `bcrypt$16384$8$1$${salt}$${hash}`,
      `scrypt$16384$8$1$${salt}`,
      `scrypt$abc$8$1$${salt}$${hash}`,
      `scrypt$16383$8$1$${salt}$${hash}`, // N not a power of two
      `scrypt$${2 ** 30}$8$1$${salt}$${hash}`, // N above the cap
      `scrypt$16384$8$1$${salt}$${hash!.slice(0, 20)}`, // short key
      `scrypt$16384$8$1$${salt}$${hash}$extra`,
    ]) {
      expect(await verifyPassword(PW, bad), bad).toBe(false);
    }
  });
});
