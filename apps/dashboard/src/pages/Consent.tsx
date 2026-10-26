// OAuth consent screen (ADR 013). /oauth/authorize sends the browser here as
// /consent?request=<id>; RequireAuth signs the user in first (and comes back). The client name is
// whatever the app registered, so the page says so and shows where the browser will be sent.
// The decision POST carries the one-time consent token from the GET (CSRF), and the redirect
// target is the client's registered redirect URI, built by the gateway.
import { useMutation, useQuery } from '@tanstack/react-query';
import { OPAQUE_ID_RE } from '@urumi/contracts';
import { useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';
import { ErrorText } from '../components/ui.js';

/** Overridable in tests (jsdom cannot navigate). */
export const navigation = { assign: (url: string) => window.location.assign(url) };

export function Consent() {
  const user = useCurrentUser();
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const valid = OPAQUE_ID_RE.test(id);
  const info = useQuery({
    queryKey: ['oauth-request', id],
    queryFn: () => api.getOAuthRequest(id),
    enabled: valid,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.decideOAuthRequest(id, { approve, consentToken: info.data!.consentToken }),
    onSuccess: (redirectTo) => navigation.assign(redirectTo),
  });

  return (
    <main className="login">
      <section className="card consent" aria-labelledby="consent-title">
        <h1 id="consent-title">Connect an app</h1>
        {!valid && (
          <p className="error">This sign-in link is not valid. Start again from your app.</p>
        )}
        {info.isPending && valid && <p>Loading…</p>}
        <ErrorText error={info.error} />
        {info.data && (
          <>
            <p>
              <strong>{info.data.client.name}</strong> wants to use Urumi tools{' '}
              <strong>as you</strong> ({user.email}).
            </p>
            <ul className="muted">
              <li>It can list and call the tools your role allows; every call is audited.</li>
              <li>
                After you choose, your browser goes to <strong>{info.data.redirectHost}</strong>.
              </li>
              <li>
                The app name is chosen by the app and not verified. Approve only if you just started
                this from an app you trust.
              </li>
              <li>You can disconnect it at any time under Connected apps.</li>
            </ul>
            <ErrorText error={decide.error} />
            <div className="actions">
              <button
                type="button"
                disabled={decide.isPending || decide.isSuccess}
                onClick={() => decide.mutate(true)}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary"
                disabled={decide.isPending || decide.isSuccess}
                onClick={() => decide.mutate(false)}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
