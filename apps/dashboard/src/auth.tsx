// GET /api/auth/me drives the shell: no user → /login; member → no admin pages.
import { useQuery } from '@tanstack/react-query';
import type { User } from '@urumi/contracts';
import { createContext, useContext, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ApiError, api } from './api.js';
import { ErrorText } from './components/ui.js';

export const ME_KEY = ['me'] as const;

const UserContext = createContext<User | null>(null);

export function useCurrentUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useCurrentUser outside RequireAuth');
  return user;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ME_KEY, queryFn: api.me, staleTime: 60_000 });
  if (me.isPending) return <p className="page-loading">Loading…</p>;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/login" replace />;
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
