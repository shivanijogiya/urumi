import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { ToolList } from '../components/ToolList.js';
import { ErrorText } from '../components/ui.js';

export function Tools() {
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.listTools });
  return (
    <section>
      <h1>Tools</h1>
      <p className="muted">Every tool you can call, from all enabled upstreams.</p>
      {tools.isPending && <p>Loading…</p>}
      <ErrorText error={tools.error} />
      {tools.data && <ToolList tools={tools.data} showServer />}
    </section>
  );
}
