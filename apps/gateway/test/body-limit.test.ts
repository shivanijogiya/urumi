// The streaming body cap (#26 hardening): an oversized upstream response is cut off while it
// streams, so the gateway never holds the whole body. The source here counts what is pulled.
import { describe, expect, it } from 'vitest';
import { limitBody, withBodyLimit } from '../src/mcp-client/body-limit.js';

const CHUNK = 64 * 1024;
const CAP = 256 * 1024;

/** A body of `total` bytes in CHUNK pieces, produced only on demand (highWaterMark 0). */
function source(total: number) {
  const stats = { produced: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.produced >= total) {
          controller.close();
          return;
        }
        const n = Math.min(CHUNK, total - stats.produced);
        stats.produced += n;
        controller.enqueue(new Uint8Array(n).fill(0x78));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

class TooLarge extends Error {}

describe('limitBody', () => {
  it('stops reading a 5 MB body just past the cap and cancels the source', async () => {
    const { stream, stats } = source(5 * 1024 * 1024);
    let exceeded = 0;
    const limited = limitBody(stream, CAP, () => {
      exceeded++;
      return new TooLarge();
    });
    await expect(new Response(limited).arrayBuffer()).rejects.toBeInstanceOf(TooLarge);
    expect(exceeded).toBe(1);
    expect(stats.produced).toBeLessThanOrEqual(CAP + CHUNK);
    expect(stats.cancelled).toBe(true);
  });

  it('passes a body at the cap through unchanged', async () => {
    const { stream, stats } = source(CAP);
    const limited = limitBody(stream, CAP, () => new TooLarge());
    const body = new Uint8Array(await new Response(limited).arrayBuffer());
    expect(body.byteLength).toBe(CAP);
    expect(stats.cancelled).toBe(false);
  });
});

describe('withBodyLimit', () => {
  it('wraps every response body and keeps status and headers', async () => {
    const { stream } = source(CAP + 1);
    const fetch = withBodyLimit(
      async () =>
        new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      CAP,
      () => new TooLarge(),
    );
    const res = await fetch('http://upstream.test/mcp');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.text()).rejects.toBeInstanceOf(TooLarge);
  });

  it('leaves body-less responses alone', async () => {
    const fetch = withBodyLimit(
      async () => new Response(null, { status: 202 }),
      CAP,
      () => new TooLarge(),
    );
    const res = await fetch('http://upstream.test/mcp');
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });
});
