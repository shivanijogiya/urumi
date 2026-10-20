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

function errorForStatus(status: number): WooError {
  if (status === 400) {
    return new WooError('VALIDATION_FAILED', 'WooCommerce rejected the request as invalid', status);
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

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  const tooLarge = () => new WooError('UPSTREAM_ERROR', 'WooCommerce response too large');
  if (declared > WOO_MAX_RESPONSE_BYTES) {
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
    if (size > WOO_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
    try {
      const res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw errorForStatus(res.status);
      }
      text = await readCapped(res);
    } catch (e) {
      if (e instanceof WooError) throw e;
      const name = e instanceof Error ? e.name : '';
      if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
        throw new WooError('UPSTREAM_TIMEOUT', 'WooCommerce did not respond in time');
      }
      throw new WooError('UPSTREAM_UNREACHABLE', 'WooCommerce is unreachable');
    }
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WooError('UPSTREAM_ERROR', 'WooCommerce returned an invalid response');
    }
  }

  return {
    get: (path, query) => request('GET', path, query),
    post: (path, body) => request('POST', path, undefined, body),
    put: (path, body) => request('PUT', path, undefined, body),
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
