// The only place an upstream credential is decrypted: headers to send to that upstream, server-side,
// for callTool / tools/list / health checks (#13). Never log or return the result.
import type { UpstreamRow } from '@urumi/contracts/db';
import { decrypt } from '../crypto/secretbox.js';

type CredentialColumns = Pick<
  UpstreamRow,
  | 'id'
  | 'credential_type'
  | 'credential_header_name'
  | 'credential_ciphertext'
  | 'credential_iv'
  | 'credential_tag'
>;

/** `{}` for no credential. Throws if the stored value does not decrypt (wrong key, tampering). */
export function credentialHeaders(row: CredentialColumns, key: Buffer): Record<string, string> {
  if (row.credential_type === 'none') return {};
  const { credential_ciphertext: ciphertext, credential_iv: iv, credential_tag: tag } = row;
  if (!ciphertext || !iv || !tag) throw new Error('upstream credential is incomplete');
  const value = decrypt(
    key,
    { ciphertext: Buffer.from(ciphertext), iv: Buffer.from(iv), tag: Buffer.from(tag) },
    row.id,
  );
  if (row.credential_type === 'bearer') return { Authorization: `Bearer ${value}` };
  if (!row.credential_header_name) throw new Error('upstream credential header is missing');
  return { [row.credential_header_name]: value };
}
