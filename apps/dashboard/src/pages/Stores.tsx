// Stores (ADR 015), admin only: the built-in store (not deletable), the stores the gateway
// provisioned (status Provisioning / Ready / Failed + reason / Deleting, storefront link, upstream
// status), a create form (slug, name, admin email) and Delete (with confirmation) / Retry. No
// password is entered or shown here: the WordPress admin and database passwords are generated
// in-cluster and stay in the store namespace's Secrets.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STORE_SLUG_RE, type Store } from '@urumi/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { Badge, ErrorText, formatTime } from '../components/ui.js';

export const STORES_KEY = ['stores'] as const;
/** Provisioning moves through steps every few seconds. */
const STORES_POLL_MS = 5000;

const PHASE_LABEL: Record<Store['phase'], string> = {
  provisioning: 'Provisioning',
  ready: 'Ready',
  failed: 'Failed',
  deleting: 'Deleting',
};

function useInvalidateAll() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: STORES_KEY });
    void client.invalidateQueries({ queryKey: ['upstreams'] });
    void client.invalidateQueries({ queryKey: ['tools'] });
    void client.invalidateQueries({ queryKey: ['permissions'] });
  };
}

export function Stores() {
  const stores = useQuery({
    queryKey: STORES_KEY,
    queryFn: api.listStores,
    refetchInterval: STORES_POLL_MS,
  });
  const [adding, setAdding] = useState(false);
  if (stores.isPending) return <p>Loading stores…</p>;
  if (stores.isError) return <ErrorText error={stores.error} />;
  const { enabled, maxStores, domainSuffix, builtIn, stores: list } = stores.data;
  const full = list.length >= maxStores;
  return (
    <section aria-label="Stores">
      <h1>Stores</h1>
      <p className="muted">
        Each store runs in its own namespace (MariaDB, WordPress + WooCommerce, its own woo-mcp) and
        is registered as an upstream named after its slug, e.g. <code>shop2__list_products</code>.
        Members get the read-only tools (list products, list orders, get order); change that under
        Permissions.
      </p>
      {!enabled && (
        <p role="alert" className="error">
          Multiple stores are not enabled on this gateway (Helm value multiStore.enabled).
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Status</th>
            <th>Storefront</th>
            <th>Upstream</th>
            <th>Updated</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {builtIn && (
            <tr>
              <td>
                <strong>{builtIn.name}</strong> <code>{builtIn.slug}</code>
                <div className="muted small">Built-in (deployed with the platform)</div>
              </td>
              <td>
                <Badge value="store-ready" label="Ready" />
              </td>
              <td className="url">
                <a href={builtIn.storefrontUrl} target="_blank" rel="noreferrer">
                  {builtIn.storefrontUrl}
                </a>
              </td>
              <td>
                <code>{builtIn.slug}</code>
              </td>
              <td />
              <td className="muted small">Not deletable</td>
            </tr>
          )}
          {list.map((s) => (
            <StoreRow key={s.id} store={s} />
          ))}
        </tbody>
      </table>
      {enabled && (
        <p className="muted small">
          {list.length} of {maxStores} stores
          {full ? ' (limit reached: delete a store to create another)' : ''}. Storefronts are at
          http://&lt;slug&gt;.{domainSuffix}.
        </p>
      )}
      {enabled &&
        (adding ? (
          <StoreForm domainSuffix={domainSuffix} onDone={() => setAdding(false)} />
        ) : (
          <button type="button" onClick={() => setAdding(true)} disabled={full}>
            Create store
          </button>
        ))}
    </section>
  );
}

function StoreRow({ store: s }: { store: Store }) {
  const invalidate = useInvalidateAll();
  const remove = useMutation({ mutationFn: () => api.deleteStore(s.id), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: () => api.retryStore(s.id), onSuccess: invalidate });
  return (
    <tr>
      <td>
        <strong>{s.name}</strong> <code>{s.slug}</code>
        <div className="muted small">
          {s.namespace} · admin {s.adminEmail}
        </div>
      </td>
      <td>
        <Badge value={`store-${s.phase}`} label={PHASE_LABEL[s.phase]} />
        {s.reason && (
          <div className={s.phase === 'failed' ? 'error small' : 'muted small'}>{s.reason}</div>
        )}
      </td>
      <td className="url">
        {s.phase === 'ready' ? (
          <a href={s.storefrontUrl} target="_blank" rel="noreferrer">
            {s.storefrontUrl}
          </a>
        ) : (
          <span className="muted">{s.storefrontUrl}</span>
        )}
      </td>
      <td>
        <code>{s.slug}</code>{' '}
        <Badge
          value={s.upstreamEnabled ? s.upstreamStatus : 'disabled'}
          label={s.upstreamEnabled ? s.upstreamStatus : 'not registered'}
        />
        <div className="muted small">{s.toolCount === 1 ? '1 tool' : `${s.toolCount} tools`}</div>
      </td>
      <td>{formatTime(s.updatedAt)}</td>
      <td className="actions">
        {s.phase === 'failed' && (
          <button
            type="button"
            className="secondary"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="danger"
          disabled={remove.isPending || s.phase === 'deleting'}
          onClick={() => {
            if (
              window.confirm(
                `Delete store ${s.name} (${s.slug})? Its namespace ${s.namespace} is deleted with all data (database and uploads), and its tools disappear. This cannot be undone.`,
              )
            ) {
              remove.mutate();
            }
          }}
        >
          Delete
        </button>
        <ErrorText error={remove.error ?? retry.error} />
      </td>
    </tr>
  );
}

export function StoreForm({ domainSuffix, onDone }: { domainSuffix: string; onDone: () => void }) {
  const invalidate = useInvalidateAll();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const save = useMutation({
    mutationFn: () => api.createStore({ slug, name, adminEmail }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const slugOk = slug === '' || STORE_SLUG_RE.test(slug);
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <form className="card" onSubmit={submit} aria-label="Create store">
      <h2>Create store</h2>
      <div className="grid">
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
            maxLength={20}
            pattern="[a-z][a-z0-9\-]{0,18}[a-z0-9]"
            aria-invalid={!slugOk}
          />
          <small className={slugOk ? 'muted' : 'error'}>
            2–20 lowercase letters, digits, hyphens; starts with a letter. Storefront: http://
            {slug || '<slug>'}.{domainSuffix} · tools {slug || '<slug>'}__*
          </small>
        </label>
        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <label>
          Admin email
          <input
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            required
            maxLength={254}
          />
          <small className="muted">
            WordPress administrator. Its password is generated in the cluster and never shown.
          </small>
        </label>
      </div>
      <ErrorText error={save.error} />
      <div className="row">
        <button type="submit" disabled={save.isPending || !slugOk}>
          Create store
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
