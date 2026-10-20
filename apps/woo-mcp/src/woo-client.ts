import { makeError, type ErrorCode } from '@urumi/contracts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WooConfig } from './config.js';
import { hostOverrideFetch } from './host-override-fetch.js';

export const WOO_TIMEOUT_MS = 10_000;
export const WOO_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const API_BASE = '/wp-json/wc/v3';
// Tools build paths from validated ids; anything else (dots, `?`, `//`) is a bug, not a request.
const SAFE_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Query = Record<string, string | number | boolean | undefined>;

export interface WooClient {
  get(path: string, query?: Query): Promise<unknown>;
  /** Like `get`, plus the response headers (e.g. `X-WP-Total` on list endpoints). */
  getWithHeaders(path: string, query?: Query): Promise<{ body: unknown; headers: Headers }>;
  post(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
}

/** A WooCommerce failure with a contracts error code. `message` is safe to show users. */
export class WooError extends Error {
  override name = 'WooError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * WooCommerce 400 codes that are safe and useful to pass on. Only the code is ever forwarded, never
 * Woo's message or data: those can echo input, internal ids, or plugin text.
 */
const PASSTHROUGH_400_CODES = new Set([
  'product_invalid_sku',
  'rest_invalid_param',
  'rest_missing_callback_param',
]);
const ERROR_BODY_MAX_BYTES = 64 * 1024;

function errorForStatus(status: number, wooCode?: string): WooError {
  if (status === 400) {
    const message = 'WooCommerce rejected the request as invalid';
    return new WooError(
      'VALIDATION_FAILED',
      wooCode && PASSTHROUGH_400_CODES.has(wooCode) ? `${message} (${wooCode})` : message,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new WooError('UPSTREAM_ERROR', 'WooCommerce rejected the server credentials', status);
  }
  if (status === 404) return new WooError('NOT_FOUND', 'Not found in WooCommerce', status);
  if (status >= 300 && status < 400) {
    return new WooError(
      'UPSTREAM_ERROR',
      'WooCommerce answered with a redirect; check WOO_URL and WOO_HOST_HEADER',
      status,
    );
  }
  if (status >= 500) return new WooError('UPSTREAM_ERROR', 'WooCommerce had an error', status);
  return new WooError('UPSTREAM_ERROR', 'WooCommerce refused the request', status);
}

async function readCapped(res: Response, maxBytes = WOO_MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  const tooLarge = () => new WooError('UPSTREAM_ERROR', 'WooCommerce response too large');
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The `code` field of a WooCommerce error body, if it has one. Never throws. */
async function wooErrorCode(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readCapped(res, ERROR_BODY_MAX_BYTES));
    const code = (parsed as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createWooClient(
  config: WooConfig,
  fetchImpl: FetchLike = config.hostHeader ? hostOverrideFetch(config.hostHeader) : fetch,
  timeoutMs: number = WOO_TIMEOUT_MS,
): WooClient {
  const auth = `Basic ${Buffer.from(`${config.user}:${config.appPassword}`).toString('base64')}`;

  async function request(method: string, path: string, query?: Query, body?: unknown) {
    if (!SAFE_PATH.test(path)) throw new WooError('INTERNAL', 'Invalid WooCommerce path');
    const url = new URL(`${config.url}${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: auth, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (config.forwardedProto) headers['x-forwarded-proto'] = config.forwardedProto;

    const signal = AbortSignal.timeout(timeoutMs);
    let text: string;
    let resHeaders: Headers;
    try {
      const res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
      if (!res.ok) {
        if (res.status === 400) throw errorForStatus(400, await wooErrorCode(res));
        await res.body?.cancel().catch(() => {});
        throw errorForStatus(res.status);
      }
      resHeaders = res.headers;
      text = await readCapped(res);
    } catch (e) {
      if (e instanceof WooError) throw e;
      const name = e instanceof Error ? e.name : '';
      if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
        throw new WooError('UPSTREAM_TIMEOUT', 'WooCommerce did not respond in time');
      }
      throw new WooError('UPSTREAM_UNREACHABLE', 'WooCommerce is unreachable');
    }
    if (text.trim() === '') return { body: null, headers: resHeaders };
    try {
      return { body: JSON.parse(text) as unknown, headers: resHeaders };
    } catch {
      throw new WooError('UPSTREAM_ERROR', 'WooCommerce returned an invalid response');
    }
  }

  const bodyOf = async (p: Promise<{ body: unknown }>) => (await p).body;
  return {
    get: (path, query) => bodyOf(request('GET', path, query)),
    getWithHeaders: (path, query) => request('GET', path, query),
    post: (path, body) => bodyOf(request('POST', path, undefined, body)),
    put: (path, body) => bodyOf(request('PUT', path, undefined, body)),
  };
}

/** Converts any thrown value into an MCP tool error carrying the contracts error envelope. */
export function toToolError(
  e: unknown,
): CallToolResult & { content: [{ type: 'text'; text: string }] } {
  const envelope =
    e instanceof WooError ? makeError(e.code, e.message) : makeError('INTERNAL', 'Internal error');
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}
