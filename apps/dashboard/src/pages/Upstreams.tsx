import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MCP_TIMEOUTS,
  type Credential,
  type UpdateUpstreamRequest,
  type Upstream,
} from '@urumi/contracts';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useCurrentUser } from '../auth.js';
import { ToolList } from '../components/ToolList.js';
import { Badge, ErrorText, formatTime } from '../components/ui.js';
import { HostedForm, HostedServers } from './HostedServers.js';

const UPSTREAMS_KEY = ['upstreams'] as const;

export function Upstreams() {
  const isAdmin = useCurrentUser().role === 'admin';
  const [adding, setAdding] = useState<false | 'remote' | 'hosted'>(false);
  // Matches the gateway's health-check cadence, so each refresh can show a new check.
  const upstreams = useQuery({
    queryKey: UPSTREAMS_KEY,
    queryFn: api.listUpstreams,
    refetchInterval: MCP_TIMEOUTS.healthIntervalMs,
  });

  return (
    <section>
      <div className="page-head">
        <h1>Upstreams</h1>
        {isAdmin && !adding && (
          <button type="button" onClick={() => setAdding('remote')}>
            Add upstream
          </button>
        )}
      </div>
      <p className="muted">
        Status refreshes every {MCP_TIMEOUTS.healthIntervalMs / 1000} seconds.
      </p>
      {adding && (
        <div className="row" role="radiogroup" aria-label="Upstream kind">
          <label className="checkbox">
            <input
              type="radio"
              name="upstream-kind"
              checked={adding === 'remote'}
              onChange={() => setAdding('remote')}
            />
            Remote (URL)
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="upstream-kind"
              checked={adding === 'hosted'}
              onChange={() => setAdding('hosted')}
            />
            Hosted (container image)
          </label>
        </div>
      )}
      {adding === 'remote' && <UpstreamForm onDone={() => setAdding(false)} />}
      {adding === 'hosted' && <HostedForm onDone={() => setAdding(false)} />}
      {isAdmin && (adding === 'hosted' || upstreams.data?.some((u) => u.hosted)) && (
        <HostedServers />
      )}
      {upstreams.isPending && <p>Loading…</p>}
      <ErrorText error={upstreams.error} />
      {upstreams.data &&
        (upstreams.data.length === 0 ? (
          <p className="muted">No upstreams yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Tools</th>
                <th>Last checked</th>
                <th>Credential</th>
                {isAdmin && <th>URL</th>}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {upstreams.data.map((u) => (
                <UpstreamRow key={u.id} upstream={u} isAdmin={isAdmin} />
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

/**
 * The data cells of one row. Reads only the fields it names, so anything else on the object
 * (a stray `credential`, say) can never reach the page.
 */
export function UpstreamSummary({
  upstream: u,
  isAdmin,
}: {
  upstream: Upstream;
  isAdmin: boolean;
}) {
  return (
    <>
      <td>
        <strong>{u.name}</strong> <code>{u.slug}</code>
        {u.hosted && <span className="tag">hosted</span>}
        {!u.enabled && <span className="tag">{u.hosted ? 'not registered yet' : 'disabled'}</span>}
      </td>
      <td>
        <Badge value={u.status} />
        {u.lastError && <div className="error small">{u.lastError}</div>}
      </td>
      <td>{u.toolCount === 1 ? '1 tool' : `${u.toolCount} tools`}</td>
      <td>{formatTime(u.lastCheckedAt)}</td>
      <td>{`credential: ${u.hasCredential ? u.credentialType : 'none'}`}</td>
      {isAdmin && <td className="url">{u.url}</td>}
    </>
  );
}

function UpstreamRow({ upstream: u, isAdmin }: { upstream: Upstream; isAdmin: boolean }) {
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: UPSTREAMS_KEY });
    void client.invalidateQueries({ queryKey: ['tools'] });
  };
  const update = useMutation({
    mutationFn: (body: UpdateUpstreamRequest) => api.updateUpstream(u.id, body),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => api.deleteUpstream(u.id), onSuccess: refresh });
  const colSpan = isAdmin ? 7 : 6;

  return (
    <>
      <tr>
        <UpstreamSummary upstream={u} isAdmin={isAdmin} />
        <td className="actions">
          <button
            type="button"
            className="secondary"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide tools' : 'Show tools'}
          </button>
          {isAdmin && !u.hosted && (
            <>
              <button type="button" className="secondary" onClick={() => setEditing(!editing)}>
                Edit
              </button>
              <button
                type="button"
                className="secondary"
                disabled={update.isPending}
                onClick={() => update.mutate({ enabled: !u.enabled })}
              >
                {u.enabled ? 'Disable' : 'Enable'}
              </button>
              {u.hasCredential && (
                <button
                  type="button"
                  className="secondary"
                  disabled={update.isPending}
                  onClick={() => {
                    if (window.confirm(`Remove the credential from ${u.name}?`)) {
                      update.mutate({ credential: null });
                    }
                  }}
                >
                  Remove credential
                </button>
              )}
              <button
                type="button"
                className="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(`Remove upstream ${u.name}? Its tools disappear for everyone.`)
                  ) {
                    remove.mutate();
                  }
                }}
              >
                Remove
              </button>
            </>
          )}
        </td>
      </tr>
      {(update.error || remove.error) && (
        <tr>
          <td colSpan={colSpan}>
            <ErrorText error={update.error ?? remove.error} />
          </td>
        </tr>
      )}
      {editing && (
        <tr>
          <td colSpan={colSpan}>
            <UpstreamForm existing={u} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
      {expanded && (
        <tr>
          <td colSpan={colSpan}>
            <UpstreamTools id={u.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function UpstreamTools({ id }: { id: string }) {
  const tools = useQuery({
    queryKey: [...UPSTREAMS_KEY, id, 'tools'],
    queryFn: () => api.listUpstreamTools(id),
  });
  if (tools.isPending) return <p>Loading tools…</p>;
  if (tools.isError) return <ErrorText error={tools.error} />;
  return <ToolList tools={tools.data} />;
}

type CredentialMode = 'keep' | 'none' | 'bearer' | 'header';

/**
 * Create (no `existing`) or edit. The credential value is write-only: a password input that
 * starts empty, is never filled from the server, and is wiped as soon as the form is submitted.
 */
function UpstreamForm({ existing, onDone }: { existing?: Upstream; onDone: () => void }) {
  const client = useQueryClient();
  const formId = useId();
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<CredentialMode>(existing ? 'keep' : 'none');
  const [headerName, setHeaderName] = useState('');
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (credential: Credential | undefined) => {
      if (!existing) return api.createUpstream({ slug, name, url, enabled, credential });
      const body: UpdateUpstreamRequest = {};
      if (name !== existing.name) body.name = name;
      if (url !== (existing.url ?? '')) body.url = url;
      if (credential) body.credential = credential;
      return api.updateUpstream(existing.id, body);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: UPSTREAMS_KEY });
      void client.invalidateQueries({ queryKey: ['tools'] });
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const credential: Credential | undefined =
      mode === 'bearer'
        ? { type: 'bearer', value }
        : mode === 'header'
          ? { type: 'header', headerName, value }
          : undefined;
    setValue('');
    save.mutate(credential);
  }

  const needsValue = mode === 'bearer' || mode === 'header';
  const current = existing?.hasCredential ? existing.credentialType : 'none';
  return (
    <form
      className="card"
      onSubmit={submit}
      aria-label={existing ? 'Edit upstream' : 'Add upstream'}
    >
      <h2>{existing ? `Edit ${existing.name}` : 'Add upstream'}</h2>
      <div className="grid">
        <div className="field">
          <label>
            Slug
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={!!existing}
              required
              maxLength={20}
              aria-describedby={`${formId}-slug-hint`}
            />
          </label>
          <small id={`${formId}-slug-hint`}>
            {existing
              ? 'Part of every tool name, so it cannot change.'
              : 'Lowercase letters, digits, hyphens.'}
          </small>
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <label className="wide">
          URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder="https://example.com/mcp"
          />
        </label>
        {!existing && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        )}
      </div>
      <fieldset>
        <legend>
          Credential {existing && <span className="muted">(current: {current})</span>}
        </legend>
        <div className="grid">
          <label>
            Credential
            <select value={mode} onChange={(e) => setMode(e.target.value as CredentialMode)}>
              {existing ? (
                <option value="keep">Keep current</option>
              ) : (
                <option value="none">None</option>
              )}
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          {mode === 'header' && (
            <label>
              Header name
              <input
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                required
                placeholder="X-Api-Key"
              />
            </label>
          )}
          <div className="field">
            <label>
              Credential value
              <input
                type="password"
                autoComplete="new-password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!needsValue}
                required={needsValue}
                aria-describedby={`${formId}-value-hint`}
              />
            </label>
            <small id={`${formId}-value-hint`}>
              Write-only: stored encrypted, never shown again.
            </small>
          </div>
        </div>
      </fieldset>
      <ErrorText error={save.error} />
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {existing ? 'Save changes' : 'Create upstream'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
