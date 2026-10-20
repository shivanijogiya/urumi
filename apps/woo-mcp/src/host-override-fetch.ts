import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A minimal `fetch` over node:http(s) that sends a fixed Host header. Node's built-in fetch silently
 * drops a Host override, so the WooCommerce client uses this only when WOO_HOST_HEADER is set.
 * Never follows redirects (like `redirect: 'manual'`); the body is streamed so callers can cap it.
 */
export function hostOverrideFetch(host: string) {
  return (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const isHttps = target.protocol === 'https:';
      const headers = Object.fromEntries(new Headers(init.headers));
      headers.host = host;
      const signal = init.signal ?? undefined;

      const req = (isHttps ? https : http).request(
        target,
        {
          method: init.method ?? 'GET',
          headers,
          signal,
          // Node derives TLS SNI from the Host header; keep it on the real hostname.
          ...(isHttps ? { servername: target.hostname } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const v of Array.isArray(value) ? value : [value]) {
              if (v !== undefined) responseHeaders.append(name, v);
            }
          }
          if (NULL_BODY_STATUSES.has(status)) {
            res.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, headers: responseHeaders }));
        },
      );
      req.on('error', (err) => {
        reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: err }));
      });
      if (typeof init.body === 'string') req.write(init.body);
      req.end();
    });
}
