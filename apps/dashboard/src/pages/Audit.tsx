import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { OutcomeSchema, type AuditQuery } from '@urumi/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';
import { Badge, ErrorText, formatTime } from '../components/ui.js';

interface Filters {
  userId: string;
  serverSlug: string;
  tool: string;
  outcome: string;
  from: string; // datetime-local value, browser local time
  to: string;
}
const EMPTY: Filters = { userId: '', serverSlug: '', tool: '', outcome: '', from: '', to: '' };

/** Form values → API query. Empty strings are dropped by auditQueryString. */
function toQuery(f: Filters): Partial<AuditQuery> {
  const iso = (v: string) => (v ? new Date(v).toISOString() : undefined);
  return {
    userId: f.userId || undefined,
    serverSlug: f.serverSlug.trim() || undefined,
    tool: f.tool.trim() || undefined,
    outcome: (f.outcome || undefined) as AuditQuery['outcome'],
    from: iso(f.from),
    to: iso(f.to),
  };
}

export function Audit() {
  const isAdmin = useCurrentUser().role === 'admin';
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  // Admins filter by user; for members the gateway pins userId to their own id anyway.
  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers, enabled: isAdmin });

  const audit = useInfiniteQuery({
    queryKey: ['audit', applied],
    queryFn: ({ pageParam }) => api.listAudit({ ...toQuery(applied), cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const set = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    setApplied(draft);
  }

  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section>
      <h1>Audit log</h1>
      <p className="muted">
        {isAdmin ? 'Every tool call, by every user.' : 'Your tool calls.'} Arguments and results are
        not stored.
      </p>
      <form className="card filters" onSubmit={submit} aria-label="Audit filters">
        {isAdmin && (
          <label>
            User
            <select value={draft.userId} onChange={set('userId')}>
              <option value="">All users</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Server
          <input value={draft.serverSlug} onChange={set('serverSlug')} placeholder="woo" />
        </label>
        <label>
          Tool
          <input value={draft.tool} onChange={set('tool')} placeholder="list_orders" />
        </label>
        <label>
          Outcome
          <select value={draft.outcome} onChange={set('outcome')}>
            <option value="">Any</option>
            {OutcomeSchema.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="datetime-local" value={draft.from} onChange={set('from')} />
        </label>
        <label>
          To
          <input type="datetime-local" value={draft.to} onChange={set('to')} />
        </label>
        <div className="row">
          <button type="submit">Apply filters</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
            }}
          >
            Reset
          </button>
        </div>
      </form>

      {audit.isPending && <p>Loading…</p>}
      <ErrorText error={audit.error} />
      {audit.isSuccess &&
        (items.length === 0 ? (
          <p className="muted">No audit entries.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {isAdmin && <th>User</th>}
                <th>Source</th>
                <th>Server</th>
                <th>Tool</th>
                <th>Outcome</th>
                <th>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{formatTime(a.startedAt)}</td>
                  {isAdmin && <td>{a.userEmail}</td>}
                  <td>{a.source}</td>
                  <td>{a.serverSlug}</td>
                  <td>
                    <code>{a.tool}</code>
                  </td>
                  <td>
                    <Badge value={a.outcome} />
                  </td>
                  <td>{a.durationMs} ms</td>
                  <td>{a.errorCode ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {audit.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          {audit.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
