// callTool: THE one path by which any tool runs, for the chat agent (#19) and external MCP clients
// (#15) alike. Resolve `{slug}__{tool}` → upstream (exists, enabled, not down, tool listed) → call it
// with the server-side credential under the 15 s timeout → return the MCP CallToolResult or throw a
// GatewayError. Every call, successful or not, ends in onCallFinished (the audit hook).
//
// Client-facing messages name at most the slug (validated `[a-z0-9-]`): never a URL, address,
// credential or raw upstream text. Details go to the server log as fixed-vocabulary strings.
import { MCP_TIMEOUTS, parseQualifiedName, type ErrorCode, type Outcome } from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../http/errors.js';
import { UpstreamError, type UpstreamClient } from '../mcp-client/upstream-client.js';
import { findUpstreamBySlug } from '../upstreams/repo.js';
import { jsonBytes, MAX_RESULT_BYTES } from './limits.js';
import { isListable, type RegisteredTool, type ToolRegistry } from './registry.js';

export const DEFAULT_CALL_TIMEOUT_MS = MCP_TIMEOUTS.callMs;
/** An unknown name refreshes the upstream's list only if the cached one is older than this. */
const UNKNOWN_TOOL_REFRESH_MS = 5_000;
const MAX_NAME_LEN = 200;

/** A typed failure of callTool; the server error handler turns it into the contracts envelope. */
export class GatewayError extends HttpError {
  override name = 'GatewayError';
}

export type CallSource = 'mcp' | 'chat';

export interface CallOptions {
  source: CallSource;
  /** The API key used by an external MCP client (#15); null/absent for chat. */
  apiKeyId?: string | null;
}

/** What the audit row (#16) is made of. Arguments and results are deliberately absent. */
export interface CallRecord {
  userId: string;
  apiKeyId: string | null;
  source: CallSource;
  /** Parsed slug; '' if the name was not qualified. */
  serverSlug: string;
  /** The upstream's tool name if resolved, else the requested tool part (capped). */
  tool: string;
  startedAt: Date;
  durationMs: number;
  outcome: Outcome;
  errorCode: ErrorCode | null;
}

export type CallTool = (
  userId: string,
  qualifiedName: string,
  args: unknown,
  opts: CallOptions,
) => Promise<CallToolResult>;

export interface CallToolDeps {
  pool: pg.Pool;
  registry: ToolRegistry;
  client: UpstreamClient;
  log: FastifyBaseLogger;
  callTimeoutMs?: number;
  /** ── AUDIT HOOK (#16) ── called once per call, awaited; failures are logged, not thrown. */
  onCallFinished?: (record: CallRecord) => void | Promise<void>;
}

const OUTCOME: Partial<Record<ErrorCode, Outcome>> = {
  UPSTREAM_TIMEOUT: 'timeout',
  TOOL_NOT_FOUND: 'denied',
  UPSTREAM_DISABLED: 'denied',
  VALIDATION_FAILED: 'denied',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createCallTool(deps: CallToolDeps): CallTool {
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const notFound = () => new GatewayError('TOOL_NOT_FOUND', 'Tool not found');
  const unreachable = (slug: string) =>
    new GatewayError('UPSTREAM_UNREACHABLE', `Server '${slug}' is unreachable`);

  async function resolve(
    qualifiedName: string,
  ): Promise<{ row: UpstreamRow; tool: RegisteredTool }> {
    const parsed = parseQualifiedName(qualifiedName);
    if (!parsed) throw notFound();
    const row = await findUpstreamBySlug(deps.pool, parsed.slug);
    if (!row) throw notFound();
    if (!row.enabled)
      throw new GatewayError('UPSTREAM_DISABLED', `Server '${row.slug}' is disabled`);
    if (!isListable(row)) throw unreachable(row.slug);
    const find = async (maxAgeMs?: number) => {
      try {
        return (await deps.registry.toolsFor(row, maxAgeMs)).find((t) => t.name === qualifiedName);
      } catch (err) {
        deps.log.warn(
          { upstream: row.slug, reason: (err as Error).message },
          'tool list unavailable for call',
        );
        throw unreachable(row.slug);
      }
    };
    const tool = (await find()) ?? (await find(UNKNOWN_TOOL_REFRESH_MS));
    if (!tool) throw notFound();
    return { row, tool };
  }

  function toGatewayError(err: UpstreamError, slug: string): GatewayError {
    if (err.kind === 'timeout') {
      return new GatewayError(
        'UPSTREAM_TIMEOUT',
        `Server '${slug}' did not respond within ${callTimeoutMs / 1000} s`,
      );
    }
    if (err.kind === 'unreachable') return unreachable(slug);
    return new GatewayError('UPSTREAM_ERROR', `Server '${slug}' returned an error`);
  }

  return async function callTool(userId, qualifiedName, args, opts) {
    const startedAt = new Date();
    const parsed = typeof qualifiedName === 'string' ? parseQualifiedName(qualifiedName) : null;
    const record: CallRecord = {
      userId,
      apiKeyId: opts.apiKeyId ?? null,
      source: opts.source,
      serverSlug: parsed?.slug ?? '',
      tool: String(parsed?.toolPart ?? qualifiedName).slice(0, MAX_NAME_LEN),
      startedAt,
      durationMs: 0,
      outcome: 'error',
      errorCode: null,
    };
    try {
      if (typeof qualifiedName !== 'string' || qualifiedName.length > MAX_NAME_LEN) {
        throw notFound();
      }
      if (!isPlainObject(args)) {
        throw new GatewayError('VALIDATION_FAILED', 'Tool arguments must be a JSON object');
      }
      const { row, tool } = await resolve(qualifiedName);
      record.tool = tool.originalName.slice(0, MAX_NAME_LEN);
      let result: CallToolResult;
      try {
        result = await deps.client.callTool(row, tool.originalName, args, callTimeoutMs);
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        deps.log.warn(
          { upstream: row.slug, tool: tool.name, kind: err.kind, reason: err.detail },
          'tool call failed',
        );
        throw toGatewayError(err, row.slug);
      }
      const resultBytes = jsonBytes(result);
      if (resultBytes > MAX_RESULT_BYTES) {
        deps.log.warn(
          { upstream: row.slug, tool: tool.name, bytes: resultBytes, max: MAX_RESULT_BYTES },
          'tool result too large',
        );
        throw new GatewayError('UPSTREAM_ERROR', 'Tool result too large');
      }
      record.outcome = result.isError ? 'error' : 'ok';
      return result;
    } catch (err) {
      record.errorCode = err instanceof HttpError ? err.code : 'INTERNAL';
      record.outcome = OUTCOME[record.errorCode] ?? 'error';
      throw err;
    } finally {
      record.durationMs = Date.now() - startedAt.getTime();
      // ── AUDIT HOOK: #16 writes the audit_log row here. No audit table writes in #13. ──
      if (deps.onCallFinished) {
        try {
          await deps.onCallFinished(record);
        } catch (err) {
          deps.log.error({ err: { message: (err as Error).message } }, 'onCallFinished failed');
        }
      }
    }
  };
}
