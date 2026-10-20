import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, UpdateUserRequest, User } from '@urumi/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';
import { KeyTable } from '../components/KeyTable.js';
import { CopyButton, ErrorText } from '../components/ui.js';

const USERS_KEY = ['users'] as const;

export function Members() {
  const users = useQuery({ queryKey: USERS_KEY, queryFn: api.listUsers });
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  return (
    <section>
      <h1>Members</h1>
      <CreateMemberForm onCreated={setIssued} />
      {issued && (
        <section className="card notice" role="region" aria-labelledby="temp-title">
          <h2 id="temp-title">Temporary password</h2>
          <p>Temporary password for {issued.email}:</p>
          <div className="secret">
            <code>{issued.password}</code>
            <CopyButton text={issued.password} />
          </div>
          <p className="warning">
            This password is shown only once. Copy it now and hand it to the member; they should
            change it after signing in.
          </p>
          <button type="button" className="secondary" onClick={() => setIssued(null)}>
            Dismiss
          </button>
        </section>
      )}
      {users.isPending && <p>Loading…</p>}
      <ErrorText error={users.error} />
      {users.data && (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <MemberRow key={u.id} user={u} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreateMemberForm({
  onCreated,
}: {
  onCreated: (issued: { email: string; password: string }) => void;
}) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: ({ user, tempPassword }) => {
      onCreated({ email: user.email, password: tempPassword });
      setEmail('');
      setName('');
      setRole('member');
      void client.invalidateQueries({ queryKey: USERS_KEY });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ email, name, role });
  }

  return (
    <form className="card inline" onSubmit={submit} aria-label="Create member">
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <button type="submit" disabled={create.isPending}>
        Create member
      </button>
      <ErrorText error={create.error} />
    </form>
  );
}

function MemberRow({ user: u }: { user: User }) {
  const client = useQueryClient();
  const self = useCurrentUser().id === u.id;
  const [showKeys, setShowKeys] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) => api.updateUser(u.id, body),
    onSuccess: () => void client.invalidateQueries({ queryKey: USERS_KEY }),
  });
  const selfHint = self ? 'You cannot change your own account here' : undefined;

  return (
    <>
      <tr className={u.disabledAt ? 'revoked' : undefined}>
        <td>{u.email}</td>
        <td>{u.name}</td>
        <td>
          <select
            aria-label={`Role for ${u.email}`}
            value={u.role}
            disabled={self || update.isPending}
            title={selfHint}
            onChange={(e) => update.mutate({ role: e.target.value as Role })}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </td>
        <td>{u.disabledAt ? 'disabled' : 'active'}</td>
        <td className="actions">
          <button
            type="button"
            className={u.disabledAt ? 'secondary' : 'danger'}
            disabled={self || update.isPending}
            title={selfHint}
            onClick={() => update.mutate({ disabled: !u.disabledAt })}
          >
            {u.disabledAt ? 'Enable' : 'Disable'}
          </button>
          <button
            type="button"
            className="secondary"
            aria-expanded={showKeys}
            onClick={() => setShowKeys(!showKeys)}
          >
            {showKeys ? 'Hide keys' : 'Show keys'}
          </button>
        </td>
      </tr>
      {update.error && (
        <tr>
          <td colSpan={5}>
            <ErrorText error={update.error} />
          </td>
        </tr>
      )}
      {showKeys && (
        <tr>
          <td colSpan={5}>
            <MemberKeys userId={u.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function MemberKeys({ userId }: { userId: string }) {
  const client = useQueryClient();
  const queryKey = [...USERS_KEY, userId, 'keys'];
  const keys = useQuery({ queryKey, queryFn: () => api.listUserKeys(userId) });
  const revoke = useMutation({
    mutationFn: (keyId: string) => api.revokeUserKey(userId, keyId),
    onSuccess: () => void client.invalidateQueries({ queryKey }),
  });
  if (keys.isPending) return <p>Loading keys…</p>;
  if (keys.isError) return <ErrorText error={keys.error} />;
  return (
    <>
      <ErrorText error={revoke.error} />
      <KeyTable keys={keys.data} busy={revoke.isPending} onRevoke={(k) => revoke.mutate(k.id)} />
    </>
  );
}
