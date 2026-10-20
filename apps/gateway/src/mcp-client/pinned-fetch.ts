// A minimal fetch over node:http(s) for the MCP client transport. It connects only to the addresses
// the SSRF guard already checked (a DNS answer that changes between the check and the connect
// cannot reach a blocked address) and never follows redirects (a 3xx is returned as is, so an
// upstream cannot bounce the gateway to an internal URL). Host header, SNI and certificate checks
// still use the URL's hostname. An empty address list means "resolve normally" (allow-listed hosts).
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ResolvedAddress } from '../upstreams/ssrf.js';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Statuses whose Response must have a null body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction | undefined {
  const first = addresses[0];
  if (!first) return undefined;
  return ((_hostname, options, callback) => {
    if (options.all)
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
    else callback(null, first.address, first.family);
  }) as LookupFunction;
}

function requestBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('Unsupported request body type');
}

export function pinnedFetch(addresses: readonly ResolvedAddress[]): FetchLike {
  const lookup = pinnedLookup(addresses);
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      const { signal } = init;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let body: string | Uint8Array | undefined;
      try {
        body = requestBody(init.body);
      } catch (err) {
        reject(err);
        return;
      }
      const method = (init.method ?? 'GET').toUpperCase();
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method,
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(lookup ? { lookup } : {}),
      });
      let res: http.IncomingMessage | undefined;
      const onAbort = () => {
        const reason: unknown = signal?.reason;
        const err = reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
        req.destroy(err);
        res?.destroy(err);
        reject(err);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      req.on('error', (err) => {
        cleanup();
        reject(err);
      });
      req.on('response', (incoming) => {
        res = incoming;
        incoming.on('close', cleanup);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }
        const status = incoming.statusCode ?? 0;
        const noBody = NULL_BODY_STATUS.has(status) || method === 'HEAD';
        if (noBody) incoming.resume();
        try {
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
              { status, statusText: incoming.statusMessage ?? '', headers },
            ),
          );
        } catch (err) {
          incoming.destroy();
          reject(err as Error);
        }
      });
      req.end(body);
    });
}
