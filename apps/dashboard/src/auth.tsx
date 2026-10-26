// GET /api/auth/me drives the shell: no user → /login; member → no admin pages.
import { useQuery } from '@tanstack/react-query';
import type { User } from '@urumi/contracts';
import { createContext, useContext, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, api } from './api.js';
import { ErrorText } from './components/ui.js';

export const ME_KEY = ['me'] as const;

const UserContext = createContext<User | null>(null);

export function useCurrentUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useCurrentUser outside RequireAuth');
  return user;
}

/**
 * Where the login page may send the user afterwards: only the OAuth consent page (ADR 013), with
 * a well-formed request id. Anything else is ignored, so `next` is never an open redirect.
 */
export function safeNext(next: string | null): string | null {
  return next && /^\/consent\?request=[A-Za-z0-9_-]{43}$/.test(next) ? next : null;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ME_KEY, queryFn: api.me, staleTime: 60_000 });
  const location = useLocation();
  if (me.isPending) return <p className="page-loading">Loading…</p>;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      const next = safeNext(location.pathname + location.search);
      return <Navigate to={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} replace />;
    }
    return (
      <main className="page-loading">
        <ErrorText error={me.error} />
        <button type="button" onClick={() => void me.refetch()}>
          Try again
        </button>
      </main>
    );
  }
  return <UserContext.Provider value={me.data}>{children}</UserContext.Provider>;
}

/** Route guard: admin pages are hidden from members and also unreachable by URL. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  if (user.role !== 'admin') return <Navigate to="/upstreams" replace />;
  return <>{children}</>;
}
