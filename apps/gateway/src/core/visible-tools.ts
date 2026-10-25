// What a user may see: the registry's aggregate filtered by the user's tool permissions (ADR 008).
// Every tool list — MCP tools/list, the chat agent's tool set, GET /api/tools and
// GET /api/upstreams/:id/tools — goes through here; callTool checks the same policy before it
// routes a call, so a hidden tool is also a rejected one.
import type pg from 'pg';
import { loadToolPolicy, type ToolPolicy } from '../permissions/repo.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';

/** The tool part of `{slug}__{tool}`, which permission rules match. */
export function toolPartOf(t: Pick<RegisteredTool, 'name' | 'serverSlug'>): string {
  return t.name.slice(t.serverSlug.length + 2);
}

export function filterAllowed(policy: ToolPolicy, tools: RegisteredTool[]): RegisteredTool[] {
  return tools.filter((t) => policy.allows(t.serverSlug, toolPartOf(t)));
}

export type ListToolsFor = (userId: string) => Promise<RegisteredTool[]>;

export function createListToolsFor(pool: pg.Pool, registry: ToolRegistry): ListToolsFor {
  return async (userId) => {
    const [policy, tools] = await Promise.all([loadToolPolicy(pool, userId), registry.listTools()]);
    return filterAllowed(policy, tools);
  };
}
