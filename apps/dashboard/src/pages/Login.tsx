import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, errorMessage } from '../api.js';
import { ME_KEY } from '../auth.js';

// One message for unknown email, wrong password, and disabled account alike.
const BAD_CREDENTIALS = 'Invalid email or password.';

export function Login() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (user) => {
      client.setQueryData(ME_KEY, user);
      navigate('/upstreams', { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email, password });
    setPassword('');
  }

  const error = login.error;
  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>Sign in</h1>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error instanceof ApiError && error.status === 401
              ? BAD_CREDENTIALS
              : errorMessage(error)}
          </p>
        )}
        <button type="submit" disabled={login.isPending}>
          Sign in
        </button>
      </form>
    </main>
  );
}
