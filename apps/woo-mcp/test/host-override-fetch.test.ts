import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hostOverrideFetch } from '../src/host-override-fetch.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
  }
  server = undefined;
});

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

async function start(
  respond: (seen: Seen, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () =>
      respond({ method: req.method, url: req.url, headers: req.headers, body }, res),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('hostOverrideFetch', () => {
  it('sends the overridden Host header plus method, headers, and body', async () => {
    let seen: Seen | undefined;
    const base = await start((s, res) => {
      seen = s;
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
    });

    const res = await hostOverrideFetch('store.localtest.me')(`${base}/wp-json/wc/v3/x?a=1`, {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: '{"n":1}',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen!.headers.host).toBe('store.localtest.me');
    expect(seen!.headers.authorization).toBe('Basic abc');
    expect(seen!.method).toBe('POST');
    expect(seen!.url).toBe('/wp-json/wc/v3/x?a=1');
    expect(seen!.body).toBe('{"n":1}');
  });

  it('does not follow redirects', async () => {
    const base = await start((_s, res) => {
      res.writeHead(302, { location: 'http://elsewhere.invalid/' }).end();
    });
    const res = await hostOverrideFetch('h')(`${base}/`, {});
    expect(res.status).toBe(302);
  });

  it('handles empty-body statuses', async () => {
    const base = await start((_s, res) => res.writeHead(204).end());
    const res = await hostOverrideFetch('h')(`${base}/`, {});
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('rejects with the abort reason when the signal times out', async () => {
    const base = await start(() => {
      /* never respond */
    });
    const err = await hostOverrideFetch('h')(`${base}/`, {
      signal: AbortSignal.timeout(50),
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('rejects with a TypeError when the connection is refused', async () => {
    const base = await start(() => {});
    server!.close();
    server = undefined;
    const err = await hostOverrideFetch('h')(`${base}/`, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
  });
});
