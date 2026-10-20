import type { ApiKey } from '@urumi/contracts';
import { formatTime } from './ui.js';

/** Key metadata only: the secret is never part of a list response. */
export function KeyTable({
  keys,
  onRevoke,
  busy = false,
}: {
  keys: ApiKey[];
  onRevoke: (key: ApiKey) => void;
  busy?: boolean;
}) {
  if (keys.length === 0) return <p className="muted">No keys yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Prefix</th>
          <th>Created</th>
          <th>Last used</th>
          <th>Status</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} className={k.revokedAt ? 'revoked' : undefined}>
            <td>{k.name}</td>
            <td>
              <code>{k.prefix}</code>
            </td>
            <td>{formatTime(k.createdAt)}</td>
            <td>{formatTime(k.lastUsedAt)}</td>
            <td>{k.revokedAt ? `revoked ${formatTime(k.revokedAt)}` : 'active'}</td>
            <td className="actions">
              {!k.revokedAt && (
                <button
                  type="button"
                  className="danger"
                  aria-label={`Revoke ${k.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Revoke key "${k.name}"? Clients using it stop working.`)) {
                      onRevoke(k);
                    }
                  }}
                >
                  Revoke
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
