// Network stub: the only thing tests mock. Routes are "METHOD /path/:param" → handler.
import { vi } from 'vitest';

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Headers;
  body: unknown;
}
export type StubReply = { status?: number; body?: unknown };
export type Handler = (req: StubRequest) => StubReply | Promise<StubReply>;

export function json(body: unknown, status = 200): StubReply {
  return { status, body };
}

export function envelope(status: number, code: string, message: string): StubReply {
  return { status, body: { error: { code, message } } };
}

function compile(pattern: string): (path: string) => Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_, n: string) => (names.push(n), '([^/]+)'))}$`,
  );
  return (path) => {
    const m = re.exec(path);
    if (!m) return null;
    return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]));
  };
}

/** Installs a fetch stub. Returns the recorded requests; unmatched routes fail loudly. */
export function stubApi(routes: Record<string, Handler | StubReply>) {
  const calls: StubRequest[] = [];
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    return { method, match: compile(pattern), handler };
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://app.localtest.me');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    for (const route of table) {
      const params = route.method === method ? route.match(url.pathname) : null;
      if (!params) continue;
      const req: StubRequest = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params,
        headers: new Headers(init.headers),
        body,
      };
      calls.push(req);
      const reply = typeof route.handler === 'function' ? await route.handler(req) : route.handler;
      const status = reply.status ?? 200;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unmocked request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    fetchMock,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}
