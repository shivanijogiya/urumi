// Health / Metrics (admin, ADR 011): per-server calls, error rate and p50/p95 latency over a window,
// computed by the gateway from audit_log (so it covers every replica without Prometheus), next to
// each upstream's health: status, the precise reason of its last failure and when it last worked.
// Every string from the gateway is rendered as React text.
import { useQuery } from '@tanstack/react-query';
import { describeFailure, MCP_TIMEOUTS, type ServerMetrics } from '@urumi/contracts';
import { useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorText, formatTime } from '../components/ui.js';

const WINDOWS = [
  { minutes: 15, label: 'Last 15 minutes' },
  { minutes: 60, label: 'Last hour' },
  { minutes: 1440, label: 'Last 24 hours' },
  { minutes: 10_080, label: 'Last 7 days' },
];

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
const ms = (x: number | null) => (x === null ? '—' : `${x} ms`);

export function Health() {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const summary = useQuery({
    queryKey: ['metrics-summary', windowMinutes],
    queryFn: () => api.metricsSummary(windowMinutes),
    refetchInterval: MCP_TIMEOUTS.healthIntervalMs,
  });
  const data = summary.data;

  return (
    <section>
      <div className="page-head">
        <h1>Health / Metrics</h1>
        <label>
          Window{' '}
          <select
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            aria-label="Window"
          >
            {WINDOWS.map((w) => (
              <option key={w.minutes} value={w.minutes}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        Calls, error rate and latency come from the audit log (every gateway replica writes it).
        Health is checked every {MCP_TIMEOUTS.healthIntervalMs / 1000} s by one replica
        {data?.healthLeader ? (
          <>
            {' '}
            (now <code>{data.healthLeader}</code>)
          </>
        ) : null}
        . Prometheus metrics are on each gateway pod&apos;s internal port 9464.
      </p>
      {summary.isPending && <p>Loading…</p>}
      <ErrorText error={summary.error} />
      {data && (
        <>
          <p>
            <strong>{data.totals.calls}</strong> calls, <strong>{data.totals.errors}</strong> failed
            ({pct(data.totals.errorRate)}), <strong>{data.totals.rateLimited}</strong> rate limited.
          </p>
          {data.servers.length === 0 ? (
            <p className="muted">No upstreams and no calls in this window.</p>
          ) : (
            <table className="health-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Status</th>
                  <th>Calls</th>
                  <th>Error rate</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>Why it failed</th>
                  <th>Last checked</th>
                  <th>Last OK</th>
                </tr>
              </thead>
              <tbody>
                {data.servers.map((s) => (
                  <ServerRow key={s.serverSlug} s={s} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function ServerRow({ s }: { s: ServerMetrics }) {
  const u = s.upstream;
  const healthWhy = u?.status === 'down' ? describeFailure(u.lastError) : null;
  return (
    <tr data-testid={`server-${s.serverSlug}`}>
      <td>
        <code>{s.serverSlug}</code>
        {u ? <div className="muted">{u.name}</div> : <div className="muted">not registered</div>}
      </td>
      <td>{u ? <Badge value={u.enabled ? u.status : 'disabled'} /> : '—'}</td>
      <td>{s.calls}</td>
      <td className={s.errorRate > 0 ? 'error' : undefined}>
        {s.calls ? `${pct(s.errorRate)} (${s.errors})` : '—'}
      </td>
      <td>{ms(s.p50Ms)}</td>
      <td>{ms(s.p95Ms)}</td>
      <td>
        {healthWhy && (
          <div>
            <strong>Unreachable:</strong> {healthWhy}
          </div>
        )}
        {s.topErrors.length > 0 ? (
          <ul className="plain">
            {s.topErrors.map((e) => (
              <li key={`${e.errorCode}-${e.errorDetail}`}>
                {e.count}× {describeFailure(e.errorDetail) ?? e.errorCode ?? 'error'}
                {e.errorCode ? <span className="muted"> ({e.errorCode})</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          !healthWhy && <span className="muted">—</span>
        )}
      </td>
      <td>{u ? formatTime(u.lastCheckedAt) : '—'}</td>
      <td>{u ? formatTime(u.lastOkAt) : '—'}</td>
    </tr>
  );
}
