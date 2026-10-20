import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MCP_PATH, type CreateKeyResponse } from '@urumi/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { KeyTable } from '../components/KeyTable.js';
import { CopyButton, ErrorText } from '../components/ui.js';

const KEYS_KEY = ['keys'] as const;

/** Config for an MCP client that speaks Streamable HTTP (Claude Code, Cursor, …). */
export function mcpSnippet(secret: string): string {
  const config = {
    mcpServers: {
      urumi: {
        type: 'http',
        url: window.location.origin + MCP_PATH,
        headers: { Authorization: `Bearer ${secret}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export function Keys() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  // The only copy of the secret. Cleared when the dialog closes; never cached or persisted.
  const [created, setCreated] = useState<CreateKeyResponse | null>(null);
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: api.listKeys });
  const create = useMutation({
    mutationFn: api.createKey,
    onSuccess: (res) => {
      setCreated(res);
      setName('');
      void client.invalidateQueries({ queryKey: KEYS_KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => void client.invalidateQueries({ queryKey: KEYS_KEY }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name);
  }

  return (
    <section>
      <h1>My keys</h1>
      <p className="muted">
        API keys let an MCP client call tools as you. Every call is checked and audited.
      </p>
      <form className="card inline" onSubmit={submit}>
        <label>
          Key name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="e.g. laptop"
          />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create key
        </button>
      </form>
      <ErrorText error={create.error ?? revoke.error} />
      {keys.isPending && <p>Loading…</p>}
      <ErrorText error={keys.error} />
      {keys.data && (
        <KeyTable keys={keys.data} busy={revoke.isPending} onRevoke={(k) => revoke.mutate(k.id)} />
      )}
      {created && <SecretDialog created={created} onClose={() => setCreated(null)} />}
    </section>
  );
}

function SecretDialog({ created, onClose }: { created: CreateKeyResponse; onClose: () => void }) {
  const snippet = mcpSnippet(created.secret);
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secret-title"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 id="secret-title">Your new API key</h2>
        <p className="warning">
          Copy it now. It will not be shown again — if you lose it, revoke it and create a new one.
        </p>
        <div className="secret">
          <code>{created.secret}</code>
          <CopyButton text={created.secret} label="Copy key" />
        </div>
        <h3>MCP client configuration</h3>
        <pre data-testid="mcp-snippet">{snippet}</pre>
        <div className="row">
          <CopyButton text={snippet} label="Copy snippet" />
          <button type="button" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
