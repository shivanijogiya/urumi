// Talks to one upstream MCP server with the official SDK Client over Streamable HTTP. Every
// operation opens a fresh connection (upstreams are stateless), runs under one deadline that covers
// the SSRF re-check, DNS, connect, initialize and the request itself, and closes the connection.
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
import { pinnedFetch } from './pinned-fetch.js';

const CLIENT_INFO = { name: 'urumi-gateway', version: '0.1.0' };
/** tools/list pages followed per listing; a misbehaving upstream cannot keep us paging forever. */
const MAX_LIST_PAGES = 10;

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

export interface UpstreamClientOptions {
  /** GATEWAY_ENC_KEY. */
  encKey: Buffer;
  /** UPSTREAM_ALLOWED_HOSTS. */
  allowedHosts: readonly string[];
  /** DNS resolver for the SSRF guard; the system resolver if unset. */
  lookup?: LookupFn;
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

  /** One tools/call, within `timeoutMs` in total. A tool-level failure (`isError`) is a result. */
  callTool(
    target: UpstreamTarget,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallToolResult> {
    return this.withConnection(target, timeoutMs, async (client, options) => {
      const result = await client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
        options,
      );
      const parsed = CallToolResultSchema.safeParse(result);
      if (!parsed.success) throw new UpstreamError('error', 'Unexpected response');
      return parsed.data;
    });
  }

  private async withConnection<T>(
    target: UpstreamTarget,
    timeoutMs: number,
    op: (client: Client, options: RequestOptions) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let phase: Phase = 'setup';
    let client: Client | undefined;
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new UpstreamError('timeout', 'Timed out'));
      }, timeoutMs);
    });

    const run = async (): Promise<T> => {
      const headers = credentialHeaders(target, this.opts.encKey);
      // Call-time SSRF check, after DNS; the connection is pinned to the checked addresses.
      const safe = await assertSafeUrl(target.url, {
        allow: this.opts.allowedHosts,
        ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
        timeoutMs: Math.min(DNS_TIMEOUT_MS, timeoutMs),
      });
      if (controller.signal.aborted) throw new UpstreamError('timeout', 'Timed out');
      const transport = new StreamableHTTPClientTransport(safe.url, {
        requestInit: { headers },
        fetch: pinnedFetch(safe.addresses),
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
      return await Promise.race([work, deadline]);
    } catch (err) {
      throw controller.signal.aborted
        ? new UpstreamError('timeout', 'Timed out')
        : classify(err, phase);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client?.close().catch(() => undefined);
    }
  }
}
