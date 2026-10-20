import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { ErrorText } from '../components/ui.js';

const MIN_LENGTH = 12; // ChangePasswordRequestSchema

export function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({ mutationFn: api.changePassword });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate({ currentPassword: current, newPassword: next });
    // Passwords never linger in the form, whatever the outcome.
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  return (
    <section>
      <h1>Change password</h1>
      <form className="card narrow" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <div className="field">
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_LENGTH}
              aria-describedby="new-password-hint"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <small id="new-password-hint">At least {MIN_LENGTH} characters.</small>
        </div>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {mismatch && (
          <p role="alert" className="error">
            The new passwords do not match.
          </p>
        )}
        <ErrorText error={change.error} />
        {change.isSuccess && (
          <p role="status" className="success">
            Password changed. Your other sessions were signed out.
          </p>
        )}
        <button type="submit" disabled={change.isPending}>
          Change password
        </button>
      </form>
    </section>
  );
}
