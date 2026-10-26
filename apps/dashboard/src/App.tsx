import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ApiError, setUnauthorizedHandler } from './api.js';
import { RequireAdmin, RequireAuth, safeNext } from './auth.js';
import { Layout } from './components/Layout.js';
import { Audit } from './pages/Audit.js';
import { ChangePassword } from './pages/ChangePassword.js';
import { Chat } from './pages/Chat.js';
import { ConnectedApps } from './pages/ConnectedApps.js';
import { Consent } from './pages/Consent.js';
import { Keys } from './pages/Keys.js';
import { Login } from './pages/Login.js';
import { Health } from './pages/Health.js';
import { Members } from './pages/Members.js';
import { Permissions } from './pages/Permissions.js';
import { Tools } from './pages/Tools.js';
import { Upstreams } from './pages/Upstreams.js';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry only what a retry can fix: network trouble and 5xx. Never 4xx.
        retry: (count, err) =>
          count < 2 && err instanceof ApiError && (err.status === 0 || err.status >= 500),
      },
    },
  });
}

export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** On any 401: drop every cached response and go to the login page. */
function UnauthorizedRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef('');
  here.current = location.pathname + location.search;
  const client = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.clear();
      // Signed out on the OAuth consent page: come back to it after login (ADR 013).
      const next = safeNext(here.current);
      navigate(next ? `/login?next=${encodeURIComponent(next)}` : '/login', { replace: true });
    });
  }, [client, navigate]);
  return null;
}

export function AppRoutes() {
  return (
    <>
      <UnauthorizedRedirect />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/consent"
          element={
            <RequireAuth>
              <Consent />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/upstreams" replace />} />
          <Route path="upstreams" element={<Upstreams />} />
          <Route path="tools" element={<Tools />} />
          <Route path="keys" element={<Keys />} />
          <Route path="connected-apps" element={<ConnectedApps />} />
          <Route path="audit" element={<Audit />} />
          <Route path="chat" element={<Chat />} />
          <Route path="password" element={<ChangePassword />} />
          <Route
            path="members"
            element={
              <RequireAdmin>
                <Members />
              </RequireAdmin>
            }
          />
          <Route
            path="health"
            element={
              <RequireAdmin>
                <Health />
              </RequireAdmin>
            }
          />
          <Route
            path="permissions"
            element={
              <RequireAdmin>
                <Permissions />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<Navigate to="/upstreams" replace />} />
        </Route>
      </Routes>
    </>
  );
}

export function App() {
  const [client] = useState(makeQueryClient);
  return (
    <Providers client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Providers>
  );
}
