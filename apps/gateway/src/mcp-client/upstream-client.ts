// Talks to one upstream MCP server with the official SDK Client over Streamable HTTP. Every
// operation opens a fresh connection, runs under one deadline that covers the SSRF re-check, DNS,
// connect, initialize and the request itself, and closes the connection. A stateful upstream
// (server-everything, GitLab) hands out an Mcp-Session-Id on initialize: it is ended with DELETE
// before closing, so sessions do not pile up on the upstream at one per health check.
// The credential is decrypted here, just before use, and sent only as a request header.
//
// Failures become UpstreamError with a fixed, short `detail` (no URL, address, credential or raw
// upstream text): it is safe for server logs and for upstreams.last_error.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  ErrorCode as McpErrorCode,
  McpError,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamRow } from '@urumi/contracts/db';
import { credentialHeaders } from '../upstreams/decrypt-for-call.js';
import {
  assertSafeUrl,
  DNS_TIMEOUT_MS,
  HostResolutionError,
  SsrfBlockedError,
  type LookupFn,
} from '../upstreams/ssrf.js';
import { MAX_RESULT_RESPONSE_BYTES } from '../core/limits.js';
import { withBodyLimit } from './body-limit.js';
import { pinnedFetch } from './pinned-fetch.js';

const CLIENT_INFO = { name: 'urumi-gateway', version: '0.1.0' };
/** tools/list pages followed per listing; a misbehaving upstream cannot keep us paging forever. */
const MAX_LIST_PAGES = 10;
/** Bound on the best-effort session DELETE after each operation. */
export const TERMINATE_TIMEOUT_MS = 1000;

/** What the client needs from an upstream row. */
export type UpstreamTarget = Pick<
  UpstreamRow,
  | 'id'
  | 'url'
  | 'credential_type'
  | 'credential_header_name'
  | 'credential_ciphertext'
  | 'credential_iv'
  | 'credential_tag'
>;

/**
 * `timeout`: the deadline passed. `unreachable`: no usable MCP session (blocked address, DNS,
 * refused connection, HTTP error during connect). `error`: connected, but the request failed.
 */
export type UpstreamFailure = 'timeout' | 'unreachable' | 'error';

export class UpstreamError extends Error {
  override name = 'UpstreamError';
  constructor(
    readonly kind: UpstreamFailure,
    /** Short and fixed-vocabulary; safe to log and to store as last_error. */
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** A tools/call response body passed MAX_RESULT_RESPONSE_BYTES; the upstream was cut off. */
export class ResultTooLargeError extends UpstreamError {
  override name = 'ResultTooLargeError';
  constructor() {
    super('error', 'Result too large');
  }
}

export interface UpstreamClientOptions {
  /** GATEWAY_ENC_KEY. */
  encKey: Buffer;
  /** UPSTREAM_ALLOWED_HOSTS. */
  allowedHosts: readonly string[];
  /** DNS resolver for the SSRF guard; the system resolver if unset. */
  lookup?: LookupFn;
  /** Debug log for swallowed cleanup failures (session DELETE). */
  log?: { debug(obj: object, msg: string): void };
}

type Phase = 'setup' | 'connect' | 'request';

function classify(err: unknown, phase: Phase): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (err instanceof SsrfBlockedError)
    return new UpstreamError('unreachable', 'Address not allowed');
  if (err instanceof HostResolutionError) {
    return new UpstreamError('unreachable', 'Host did not resolve');
  }
  if (err instanceof McpError && err.code === McpErrorCode.RequestTimeout) {
    return new UpstreamError('timeout', 'Timed out');
  }
  const kind: UpstreamFailure = phase === 'request' ? 'error' : 'unreachable';
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof StreamableHTTPError && typeof code === 'number' && code >= 100) {
    return new UpstreamError(kind, `HTTP ${code}`);
  }
  // Node socket errors (ECONNREFUSED, ECONNRESET, ENOTFOUND …): the code only, never the message.
  if (typeof code === 'string' && /^E[A-Z_]{2,30}$/.test(code)) {
    return new UpstreamError('unreachable', `Connection failed (${code})`);
  }
  if (err instanceof McpError) return new UpstreamError(kind, `MCP error ${err.code}`);
  return new UpstreamError(kind, phase === 'setup' ? 'Setup failed' : 'Unexpected response');
}

export class UpstreamClient {
  constructor(private readonly opts: UpstreamClientOptions) {}

  /** All tools (following pagination), within `timeoutMs` in total. */
  listTools(target: UpstreamTarget, timeoutMs: number): Promise<McpTool[]> {
    return this.withConnection(target, timeoutMs, async (client, options) => {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, options);
        tools.push(...res.tools);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    });
  }

  /**
   * One tools/call, within `timeoutMs` in total. A tool-level failure (`isError`) is a result. A
   * response body over MAX_RESULT_RESPONSE_BYTES is cut off as it streams: ResultTooLargeError.
   */
  callTool(
    target: UpstreamTarget,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallToolResult> {
    return this.withConnection(
      target,
      timeoutMs,
      async (client, options) => {
        const result = await client.callTool(
          { name, arguments: args },
          CallToolResultSchema,
          options,
        );
        const parsed = CallToolResultSchema.safeParse(result);
        if (!parsed.success) throw new UpstreamError('error', 'Unexpected response');
        return parsed.data;
      },
      MAX_RESULT_RESPONSE_BYTES,
    );
  }

  private async withConnection<T>(
    target: UpstreamTarget,
    timeoutMs: number,
    op: (client: Client, options: RequestOptions) => Promise<T>,
    /** Per HTTP response body; unlimited if unset. */
    maxResponseBytes?: number,
  ): Promise<T> {
    const controller = new AbortController();
    let phase: Phase = 'setup';
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    let tooLarge = false;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new UpstreamError('timeout', 'Timed out'));
      }, timeoutMs);
    });
    // An SSE response's body errors outside the request promise (the SDK only reports it to
    // onerror), so the cut-off also settles the race directly.
    let overflow: (err: ResultTooLargeError) => void = () => undefined;
    const overflowed = new Promise<never>((_, reject) => (overflow = reject));
    overflowed.catch(() => undefined);
    const onExceeded = () => {
      const err = new ResultTooLargeError();
      tooLarge = true;
      overflow(err);
      return err;
    };

    const run = async (): Promise<T> => {
      const headers = credentialHeaders(target, this.opts.encKey);
      // Call-time SSRF check, after DNS; the connection is pinned to the checked addresses.
      const safe = await assertSafeUrl(target.url, {
        allow: this.opts.allowedHosts,
        ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
        timeoutMs: Math.min(DNS_TIMEOUT_MS, timeoutMs),
      });
      if (controller.signal.aborted) throw new UpstreamError('timeout', 'Timed out');
      const fetch = pinnedFetch(safe.addresses);
      transport = new StreamableHTTPClientTransport(safe.url, {
        requestInit: { headers },
        fetch: maxResponseBytes ? withBodyLimit(fetch, maxResponseBytes, onExceeded) : fetch,
      });
      client = new Client(CLIENT_INFO);
      // The SDK's own per-request timeout is a backstop; the deadline above is authoritative.
      const options: RequestOptions = { signal: controller.signal, timeout: timeoutMs };
      phase = 'connect';
      await client.connect(transport, options);
      phase = 'request';
      return op(client, options);
    };

    const work = run();
    work.catch(() => undefined); // settled after a timeout; the race already reported it
    try {
      return await Promise.race([work, deadline, overflowed]);
    } catch (err) {
      if (tooLarge) throw new ResultTooLargeError();
      throw controller.signal.aborted
        ? new UpstreamError('timeout', 'Timed out')
        : classify(err, phase);
    } finally {
      clearTimeout(timer);
      controller.abort();
      const released = this.release(client, transport);
      // Past the deadline the caller is not kept waiting for cleanup; it still runs, bounded.
      if (!expired) await released;
    }
  }

  /** Best-effort session DELETE (bounded, failures debug-logged), then close. Never rejects. */
  private async release(
    client: Client | undefined,
    transport: StreamableHTTPClientTransport | undefined,
  ): Promise<void> {
    if (transport?.sessionId) {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamError('timeout', 'Timed out')),
          TERMINATE_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([transport.terminateSession(), bound]);
      } catch (err) {
        this.opts.log?.debug(
          { reason: classify(err, 'request').detail },
          'upstream session termination failed',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    // Aborts anything still in flight, including a DELETE that outlived its bound.
    await client?.close().catch(() => undefined);
  }
}
