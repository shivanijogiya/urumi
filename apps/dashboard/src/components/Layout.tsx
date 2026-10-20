import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';

export function Layout() {
  const user = useCurrentUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    // Signed out locally even if the request failed: the cookie may already be gone.
    onSettled: () => {
      client.clear();
      navigate('/login', { replace: true });
    },
  });

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Urumi</span>
        <nav aria-label="Main">
          <NavLink to="/upstreams">Upstreams</NavLink>
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/keys">My keys</NavLink>
          <NavLink to="/audit">Audit</NavLink>
          <NavLink to="/chat">Chat</NavLink>
          {user.role === 'admin' && <NavLink to="/members">Members</NavLink>}
        </nav>
        <div className="account">
          <span>{user.email}</span>
          <span className="role">{user.role}</span>
          <NavLink to="/password">Change password</NavLink>
          <button
            type="button"
            className="secondary"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
