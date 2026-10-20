// The tool registry: an in-memory cache of each upstream's tools over the upstreams table.
// listTools() asks every enabled, not-down upstream in parallel (Promise.allSettled), each capped at
// the 3 s list timeout; a failing upstream is omitted, never the whole list. Successful lists are
// cached for 30 s, keyed to the row's updated_at, so any edit (URL, credential, enable) makes the
// old entry unusable even before invalidate() runs.
//
// Upstream tool names and descriptions are untrusted data: names are qualified with
// qualifyToolName (sanitised, `{slug}__{tool}`), descriptions stripped of control characters and
// capped. The qualified → original name map lives here; routing never reverses sanitisation.
// Size caps (limits.ts): at most 200 tools per upstream; tools with an oversized inputSchema are
// dropped.
import { MCP_TIMEOUTS, qualifyToolName, type Tool } from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { UpstreamClient } from '../mcp-client/upstream-client.js';
import { listUpstreamRows } from '../upstreams/repo.js';
import { jsonBytes, MAX_INPUT_SCHEMA_BYTES, MAX_TOOLS_PER_UPSTREAM } from './limits.js';

export const DEFAULT_LIST_TIMEOUT_MS = MCP_TIMEOUTS.listMs;
export const TOOL_CACHE_TTL_MS = 30_000;
export const MAX_DESCRIPTION_CHARS = 500;

/** A tool as the gateway knows it: the qualified name plus where it routes. */
export interface RegisteredTool {
  /** `{slug}__{tool}`, sanitised. */
  name: string;
  serverSlug: string;
  upstreamId: string;
  /** The upstream's own name, used for tools/call. */
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CacheEntry {
  version: number;
  fetchedAt: number;
  tools: RegisteredTool[];
}

export interface ToolRegistryDeps {
  pool: pg.Pool;
  client: UpstreamClient;
  log: FastifyBaseLogger;
  listTimeoutMs?: number;
  cacheTtlMs?: number;
}

// C0/DEL/C1 controls, format characters (incl. bidi overrides and isolates), line/paragraph separators.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** Control characters become spaces, whitespace collapses, at most 500 code points. */
export function sanitizeDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const clean = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > MAX_DESCRIPTION_CHARS
    ? chars.slice(0, MAX_DESCRIPTION_CHARS).join('')
    : clean;
}

/** An upstream whose tools are offered: enabled and not marked down by the health loop. */
export function isListable(row: Pick<UpstreamRow, 'enabled' | 'status'>): boolean {
  return row.enabled && row.status !== 'down';
}

export function toApiTool(t: RegisteredTool): Tool {
  return {
    name: t.name,
    serverSlug: t.serverSlug,
    description: t.description,
    inputSchema: t.inputSchema,
  };
}

const versionOf = (row: Pick<UpstreamRow, 'updated_at'>) => row.updated_at.getTime();

export class ToolRegistry {
  readonly listTimeoutMs: number;
  readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<
    string,
    { version: number; promise: Promise<RegisteredTool[]> }
  >();

  constructor(private readonly deps: ToolRegistryDeps) {
    this.listTimeoutMs = deps.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.cacheTtlMs = deps.cacheTtlMs ?? TOOL_CACHE_TTL_MS;
  }

  /** Tools of every listable upstream that answers in time, ordered by slug. */
  async listTools(): Promise<RegisteredTool[]> {
    const rows = (await listUpstreamRows(this.deps.pool)).filter(isListable);
    const settled = await Promise.allSettled(rows.map((row) => this.toolsFor(row)));
    return settled.flatMap((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      this.deps.log.warn(
        { upstream: rows[i]!.slug, reason: (s.reason as Error).message },
        'upstream omitted from the tool list',
      );
      return [];
    });
  }

  /**
   * One upstream's tools: from the cache if fetched within `maxAgeMs` for the row's current
   * version, otherwise from the upstream (concurrent requests share one fetch). Throws
   * UpstreamError if the upstream does not answer. Does not check isListable.
   */
  toolsFor(row: UpstreamRow, maxAgeMs = this.cacheTtlMs): Promise<RegisteredTool[]> {
    const entry = this.cache.get(row.id);
    if (entry && entry.version === versionOf(row) && Date.now() - entry.fetchedAt < maxAgeMs) {
      return Promise.resolve(entry.tools);
    }
    const pending = this.inflight.get(row.id);
    if (pending && pending.version === versionOf(row)) return pending.promise;
    const promise = this.refresh(row).finally(() => {
      if (this.inflight.get(row.id)?.promise === promise) this.inflight.delete(row.id);
    });
    this.inflight.set(row.id, { version: versionOf(row), promise });
    return promise;
  }

  /** Fetches and caches an upstream's tools now (the health loop uses this as its ping). */
  async refresh(row: UpstreamRow, timeoutMs = this.listTimeoutMs): Promise<RegisteredTool[]> {
    const raw = await this.deps.client.listTools(row, timeoutMs);
    const tools = this.register(row, raw);
    this.cache.set(row.id, { version: versionOf(row), fetchedAt: Date.now(), tools });
    return tools;
  }

  /** Last known tool count for the row's current version; 0 if unknown or not listable. */
  toolCount(row: UpstreamRow): number {
    const entry = this.cache.get(row.id);
    return isListable(row) && entry?.version === versionOf(row) ? entry.tools.length : 0;
  }

  /** Drops one upstream's cached tools (or all), e.g. after disable, delete or going down. */
  invalidate(upstreamId?: string): void {
    if (upstreamId === undefined) {
      this.cache.clear();
      this.inflight.clear();
    } else {
      this.cache.delete(upstreamId);
      this.inflight.delete(upstreamId);
    }
  }

  private register(
    row: UpstreamRow,
    raw: { name: string; description?: string; inputSchema: object }[],
  ): RegisteredTool[] {
    if (raw.length > MAX_TOOLS_PER_UPSTREAM) {
      this.deps.log.warn(
        { upstream: row.slug, received: raw.length, kept: MAX_TOOLS_PER_UPSTREAM },
        'tool list truncated',
      );
    }
    const seen = new Set<string>();
    const tools: RegisteredTool[] = [];
    for (const t of raw.slice(0, MAX_TOOLS_PER_UPSTREAM)) {
      if (!t.name) continue;
      const name = qualifyToolName(row.slug, t.name);
      const schemaBytes = jsonBytes(t.inputSchema);
      if (schemaBytes > MAX_INPUT_SCHEMA_BYTES) {
        // The size and the sanitised name only: the schema itself is untrusted content.
        this.deps.log.warn(
          { upstream: row.slug, tool: name, bytes: schemaBytes, max: MAX_INPUT_SCHEMA_BYTES },
          'tool dropped: inputSchema too large',
        );
        continue;
      }
      if (seen.has(name)) {
        // Sanitising made two upstream names equal (`foo.bar`, `foo_bar`): keep the first.
        this.deps.log.warn(
          { upstream: row.slug, tool: name },
          'duplicate qualified tool name after sanitising; keeping the first',
        );
        continue;
      }
      seen.add(name);
      tools.push({
        name,
        serverSlug: row.slug,
        upstreamId: row.id,
        originalName: t.name,
        description: sanitizeDescription(t.description),
        inputSchema: { ...(t.inputSchema as Record<string, unknown>) },
      });
    }
    return tools;
  }
}
