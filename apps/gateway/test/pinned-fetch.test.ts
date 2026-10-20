// The call-time SSRF pin: requests go to the addresses the guard checked, never to a fresh DNS
// answer, and redirects are not followed.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pinnedFetch } from '../src/mcp-client/pinned-fetch.js';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      return;
    }
    if (req.url === '/hang') return; // never answers
    if (req.url === '/empty') {
      res.writeHead(204).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += String(c)));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-multi': ['a', 'b'] });
      res.end(
        JSON.stringify({
          method: req.method,
          host: req.headers.host,
          auth: req.headers.authorization,
          body,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const pinned = () => pinnedFetch([{ address: '127.0.0.1', family: 4 }]);

it('connects to the pinned address whatever the hostname resolves to', async () => {
  // `.invalid` never resolves (RFC 6761); reaching the server proves DNS was not consulted.
  const res = await pinned()(`http://upstream.invalid:${port}/mcp`, {
    method: 'POST',
    headers: new Headers({ authorization: 'Bearer t', 'content-type': 'application/json' }),
    body: '{"x":1}',
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-multi')).toBe('a, b');
  expect(await res.json()).toEqual({
    method: 'POST',
    host: `upstream.invalid:${port}`,
    auth: 'Bearer t',
    body: '{"x":1}',
  });
});

it('does not follow redirects', async () => {
  const res = await pinned()(new URL(`http://upstream.invalid:${port}/redirect`), {
    redirect: 'follow',
  });
  expect(res.status).toBe(302);
});

it('handles bodiless responses', async () => {
  const res = await pinned()(`http://upstream.invalid:${port}/empty`);
  expect(res.status).toBe(204);
  expect(await res.text()).toBe('');
});

it('aborts on the signal', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await expect(
    pinned()(`http://upstream.invalid:${port}/hang`, { signal: controller.signal }),
  ).rejects.toThrow();
});

it('falls back to normal resolution when there is nothing to pin (allow-listed hosts)', async () => {
  const res = await pinnedFetch([])(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '' });
  expect(res.status).toBe(200);
});
