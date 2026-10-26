// Connected apps (ADR 013): OAuth clients the user authorised. Members see their own; admins see
// everyone's. Disconnect revokes the grant: its access and refresh tokens stop working at once.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';
import { ErrorText, formatTime } from '../components/ui.js';

const APPS_KEY = ['connected-apps'] as const;

export function ConnectedApps() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const client = useQueryClient();
  const apps = useQuery({ queryKey: APPS_KEY, queryFn: api.listConnectedApps });
  const revoke = useMutation({
    mutationFn: api.revokeConnectedApp,
    onSuccess: () => void client.invalidateQueries({ queryKey: APPS_KEY }),
  });

  return (
    <section>
      <h1>Connected apps</h1>
      <p className="muted">
        MCP clients (Claude Code, Cursor, MCP Inspector, …) you signed in to with OAuth. They act as{' '}
        {isAdmin ? 'the user who approved them' : 'you'}, with the same tool permissions and audit.
        {isAdmin && ' As an admin you see and can disconnect everyone’s.'}
      </p>
      {apps.isPending && <p>Loading…</p>}
      <ErrorText error={apps.error ?? revoke.error} />
      {apps.data && apps.data.length === 0 && <p>No connected apps.</p>}
      {apps.data && apps.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>App</th>
              {isAdmin && <th>User</th>}
              <th>Redirects to</th>
              <th>Authorised</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apps.data.map((a) => (
              <tr key={a.id}>
                <td>{a.clientName}</td>
                {isAdmin && <td>{a.userEmail}</td>}
                <td>{a.redirectHosts.join(', ')}</td>
                <td>{formatTime(a.authorizedAt)}</td>
                <td>{formatTime(a.lastUsedAt)}</td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (
                        window.confirm(`Disconnect ${a.clientName}? Its tokens stop working now.`)
                      ) {
                        revoke.mutate(a.id);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
