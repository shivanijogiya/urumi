// AES-256-GCM for upstream credentials at rest. A fresh random 12-byte IV per write; the AAD binds
// the ciphertext to its row (the upstream id), so ciphertext copied onto another row fails to open.
// Any wrong key, AAD, IV, ciphertext or tag makes decrypt throw (GCM authentication).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
}

export function encrypt(key: Buffer, plaintext: string, aad: string): Sealed {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decrypt(key: Buffer, sealed: Sealed, aad: string): string {
  checkKey(key);
  // Without these checks GCM would accept a truncated tag.
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
    throw new Error('malformed sealed value');
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
