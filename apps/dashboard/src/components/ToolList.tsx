import type { Tool } from '@urumi/contracts';

/** Tool names and descriptions come from upstream servers: untrusted, rendered as plain text. */
export function ToolList({ tools, showServer = false }: { tools: Tool[]; showServer?: boolean }) {
  if (tools.length === 0) return <p className="muted">No tools.</p>;
  return (
    <ul className="tool-list">
      {tools.map((t) => (
        <li key={t.name}>
          <code>{t.name}</code>
          {showServer && <span className="muted"> on {t.serverSlug}</span>}
          <p className="description">{t.description}</p>
        </li>
      ))}
    </ul>
  );
}
