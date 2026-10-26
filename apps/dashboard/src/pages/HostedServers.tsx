// Hosted MCP servers (ADR 014), admin only: the "Hosted (container image)" add form and the status
// table. Env var values are write-only: password inputs that start empty, are never filled from the
// server (which only returns names) and are cleared as soon as the form is submitted.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostedServer } from '@urumi/contracts';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { Badge, ErrorText, formatTime } from '../components/ui.js';

export const HOSTED_KEY = ['hosted-servers'] as const;
/** Phases change within seconds while a pod starts. */
const HOSTED_POLL_MS = 5000;

const PHASE_LABEL: Record<HostedServer['phase'], string> = {
  deploying: 'Deploying',
  connected: 'Connected',
  unreachable: 'Unreachable',
  failed: 'Failed',
  deleting: 'Deleting',
};

export function useHostedServers(enabled: boolean) {
  return useQuery({
    queryKey: HOSTED_KEY,
    queryFn: api.listHostedServers,
    refetchInterval: HOSTED_POLL_MS,
    enabled,
  });
}

export function HostedPhase({ server }: { server: Pick<HostedServer, 'phase' | 'reason'> }) {
  return (
    <>
      <Badge value={`hosted-${server.phase}`} label={PHASE_LABEL[server.phase]} />
      {server.reason && (
        <div className={server.phase === 'failed' ? 'error small' : 'muted small'}>
          {server.reason}
        </div>
      )}
    </>
  );
}

export function HostedServers() {
  const hosted = useHostedServers(true);
  if (hosted.isPending) return <p>Loading hosted servers…</p>;
  if (hosted.isError) return <ErrorText error={hosted.error} />;
  const servers = hosted.data.servers;
  if (servers.length === 0) return null;
  return (
    <section aria-label="Hosted servers">
      <h2>Hosted servers</h2>
      <p className="muted">
        Run by the gateway in the cluster from a container image; registered as an upstream once
        ready. Members see their tools only after you grant them under Permissions.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Image</th>
            <th>Settings</th>
            <th>Updated</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <HostedRow key={s.id} server={s} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HostedRow({ server: s }: { server: HostedServer }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteHostedServer(s.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: HOSTED_KEY });
      void client.invalidateQueries({ queryKey: ['upstreams'] });
      void client.invalidateQueries({ queryKey: ['tools'] });
    },
  });
  return (
    <tr>
      <td>
        <strong>{s.name}</strong> <code>{s.slug}</code>
        <div className="muted small">{s.toolCount === 1 ? '1 tool' : `${s.toolCount} tools`}</div>
      </td>
      <td>
        <HostedPhase server={s} />
      </td>
      <td className="url">
        {s.image}
        {s.imageDigest && <div className="muted small">pinned {s.imageDigest.slice(0, 19)}…</div>}
      </td>
      <td className="small">
        port {s.port} · {s.mcpPath} · {s.preset} · egress {s.egress ? 'internet' : 'none'}
        {s.envKeys.length > 0 && <div className="muted">env: {s.envKeys.join(', ')}</div>}
      </td>
      <td>{formatTime(s.updatedAt)}</td>
      <td className="actions">
        <button
          type="button"
          className="danger"
          disabled={remove.isPending || s.phase === 'deleting'}
          onClick={() => {
            if (window.confirm(`Delete hosted server ${s.name}? Its pod and tools are removed.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </button>
        <ErrorText error={remove.error} />
      </td>
    </tr>
  );
}

interface EnvRow {
  key: number;
  name: string;
  value: string;
}

export function HostedForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const formId = useId();
  const config = useHostedServers(true);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [port, setPort] = useState('8080');
  const [mcpPath, setMcpPath] = useState('/mcp');
  const [preset, setPreset] = useState<'small' | 'medium'>('small');
  const [egress, setEgress] = useState(false);
  const [env, setEnv] = useState<EnvRow[]>([]);

  const save = useMutation({
    mutationFn: (vars: Record<string, string>) =>
      api.createHostedServer({
        slug,
        name,
        image: image.trim(),
        port: Number(port),
        mcpPath,
        preset,
        egress,
        ...(Object.keys(vars).length ? { env: vars } : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: HOSTED_KEY });
      void client.invalidateQueries({ queryKey: ['upstreams'] });
      onDone();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const vars = Object.fromEntries(env.filter((r) => r.name).map((r) => [r.name, r.value]));
    // Values leave the page once; the inputs are wiped whether or not the request succeeds.
    setEnv((rows) => rows.map((r) => ({ ...r, value: '' })));
    save.mutate(vars);
  }

  const prefixes = config.data?.allowedImagePrefixes ?? [];
  const disabled = config.data && !config.data.enabled;
  return (
    <form className="card" onSubmit={submit} aria-label="Add hosted server">
      <h2>Add hosted server (container image)</h2>
      {disabled && (
        <p role="alert" className="error">
          Hosted MCP servers are not enabled on this gateway (Helm value hosted.enabled).
        </p>
      )}
      <div className="grid">
        <label>
          Slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} required maxLength={20} />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <div className="field wide">
          <label>
            Image
            <input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              required
              placeholder="k3d-urumi-registry.localhost:5005/urumi-everything:dev"
              aria-describedby={`${formId}-image-hint`}
            />
          </label>
          <small id={`${formId}-image-hint`}>
            {prefixes.length
              ? `Allowed: ${prefixes.join(', ')}`
              : 'No image prefixes are allowed yet (hosted.allowedImages).'}
            {config.data?.requireDigest
              ? ' Must be pinned with @sha256:…'
              : ' Pin with @sha256:… to record a digest.'}
          </small>
        </div>
        <label>
          Container port
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            required
          />
        </label>
        <label>
          MCP path
          <input value={mcpPath} onChange={(e) => setMcpPath(e.target.value)} required />
        </label>
        <label>
          Resources
          <select value={preset} onChange={(e) => setPreset(e.target.value as 'small' | 'medium')}>
            <option value="small">Small (≤ 250m CPU, 128 MiB)</option>
            <option value="medium">Medium (≤ 500m CPU, 256 MiB)</option>
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={egress} onChange={(e) => setEgress(e.target.checked)} />
          Allow internet egress (80/443, no private ranges)
        </label>
      </div>
      <fieldset>
        <legend>Environment variables</legend>
        <small className="muted">Values are write-only: stored encrypted, never shown again.</small>
        {env.map((row) => (
          <div className="row" key={row.key}>
            <label>
              Name
              <input
                value={row.name}
                onChange={(e) =>
                  setEnv((rows) =>
                    rows.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)),
                  )
                }
                required
                pattern="[A-Za-z_][A-Za-z0-9_]{0,63}"
              />
            </label>
            <label>
              Value
              <input
                type="password"
                autoComplete="new-password"
                value={row.value}
                onChange={(e) =>
                  setEnv((rows) =>
                    rows.map((r) => (r.key === row.key ? { ...r, value: e.target.value } : r)),
                  )
                }
                required
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => setEnv((rows) => rows.filter((r) => r.key !== row.key))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={env.length >= 20}
          onClick={() => setEnv((rows) => [...rows, { key: Date.now(), name: '', value: '' }])}
        >
          Add variable
        </button>
      </fieldset>
      <ErrorText error={save.error} />
      <div className="row">
        <button type="submit" disabled={save.isPending || !!disabled}>
          Deploy hosted server
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
