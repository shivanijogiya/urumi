// Admin: tool permission rules (ADR 008). Rules are evaluated by the gateway on every tools/list
// and tools/call; the preview below runs the same contracts function (isToolAllowed) over the
// tools the admin can see, so what it shows is what the gateway enforces.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isToolAllowed,
  parseQualifiedName,
  type PermissionEffect,
  type PermissionRule,
  type Role,
} from '@urumi/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { Badge, ErrorText } from '../components/ui.js';

const RULES_KEY = ['permissions'] as const;

/** `role:member`, `role:admin` or `user:<id>`. */
type SubjectKey = string;

function subjectLabel(r: PermissionRule): string {
  return r.role ? `role: ${r.role}` : `user: ${r.userEmail ?? r.userId}`;
}

export function Permissions() {
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: api.listPermissions });
  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.listTools });
  return (
    <section>
      <h1>Tool permissions</h1>
      <p className="hint">
        A tool no rule allows is hidden from tools/list and rejected if called (audited as{' '}
        <code>denied</code>). A user&apos;s own rules override their role&apos;s; the most specific
        rule wins (exact server, then exact tool, then the longest <code>prefix*</code>); deny wins
        a tie.
      </p>
      <RuleForm users={users.data ?? []} />
      {rules.isPending && <p>Loading…</p>}
      <ErrorText error={rules.error} />
      {rules.data && <RuleTable rules={rules.data} />}
      {rules.data && tools.data && (
        <Preview
          rules={rules.data}
          users={users.data ?? []}
          tools={tools.data.map((t) => t.name)}
        />
      )}
    </section>
  );
}

function RuleForm({ users }: { users: { id: string; email: string }[] }) {
  const client = useQueryClient();
  const [subject, setSubject] = useState<SubjectKey>('role:member');
  const [serverSlug, setServerSlug] = useState('');
  const [tool, setTool] = useState('');
  const [effect, setEffect] = useState<PermissionEffect>('allow');
  const save = useMutation({
    mutationFn: api.upsertPermission,
    onSuccess: () => {
      setTool('');
      void client.invalidateQueries({ queryKey: RULES_KEY });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const [kind, value] = subject.split(':') as ['role' | 'user', string];
    save.mutate({
      ...(kind === 'role' ? { role: value as Role } : { userId: value }),
      serverSlug,
      tool,
      effect,
    });
  }

  return (
    <form className="card inline" onSubmit={submit} aria-label="Add rule">
      <label>
        Subject
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="role:member">role: member</option>
          <option value="role:admin">role: admin</option>
          {users.map((u) => (
            <option key={u.id} value={`user:${u.id}`}>
              user: {u.email}
            </option>
          ))}
        </select>
      </label>
      <label>
        Server
        <input
          value={serverSlug}
          onChange={(e) => setServerSlug(e.target.value)}
          placeholder="woo or *"
          required
        />
      </label>
      <label>
        Tool
        <input
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          placeholder="create_product, list_*, *"
          required
        />
      </label>
      <label>
        Effect
        <select value={effect} onChange={(e) => setEffect(e.target.value as PermissionEffect)}>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </label>
      <button type="submit" disabled={save.isPending}>
        Save rule
      </button>
      <ErrorText error={save.error} />
    </form>
  );
}

function RuleTable({ rules }: { rules: PermissionRule[] }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: api.deletePermission,
    onSuccess: () => void client.invalidateQueries({ queryKey: RULES_KEY }),
  });
  return (
    <>
      <ErrorText error={remove.error} />
      <table aria-label="Rules">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Effect</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{subjectLabel(r)}</td>
              <td>
                <code>{r.serverSlug}</code>
              </td>
              <td>
                <code>{r.tool}</code>
              </td>
              <td>
                <Badge value={r.effect === 'allow' ? 'ok' : 'denied'} />
              </td>
              <td className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={remove.isPending}
                  aria-label={`Delete ${subjectLabel(r)} ${r.serverSlug} ${r.tool}`}
                  onClick={() => remove.mutate(r.id)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Preview({
  rules,
  users,
  tools,
}: {
  rules: PermissionRule[];
  users: { id: string; email: string; role: Role }[];
  tools: string[];
}) {
  const [subject, setSubject] = useState<SubjectKey>('role:member');
  const [kind, value] = subject.split(':') as ['role' | 'user', string];
  const u = users.find((x) => x.id === value);
  // A role preview uses a user id no rule names, so only role rules apply.
  const who =
    kind === 'role'
      ? { userId: '00000000-0000-0000-0000-000000000000', role: value as Role }
      : { userId: value, role: u?.role ?? 'member' };
  const allowed = (name: string) => {
    const p = parseQualifiedName(name);
    return !!p && isToolAllowed(rules, who, p.slug, p.toolPart);
  };
  return (
    <section className="card" aria-labelledby="preview-title">
      <h2 id="preview-title">Effective access</h2>
      <label>
        Preview as
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="role:member">role: member</option>
          <option value="role:admin">role: admin</option>
          {users.map((x) => (
            <option key={x.id} value={`user:${x.id}`}>
              user: {x.email}
            </option>
          ))}
        </select>
      </label>
      <ul className="tool-access" aria-label="Effective tools">
        {tools.map((name) => (
          <li key={name}>
            <code>{name}</code> <Badge value={allowed(name) ? 'ok' : 'denied'} />
          </li>
        ))}
      </ul>
    </section>
  );
}
