// Caps how much of an upstream HTTP response body the gateway reads. Bytes are counted as chunks
// arrive, so an oversized body is cut off after at most `maxBytes` plus one chunk: the source is
// cancelled (for pinnedFetch that destroys the socket) and the body errors, instead of the whole
// body being buffered and measured afterwards.
import type { FetchLike } from './pinned-fetch.js';

/**
 * `body`, failing with `onExceeded()`'s error once more than `maxBytes` have been read. Pulls one
 * chunk per read (highWaterMark 0), so nothing is read ahead of the consumer.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => Error,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let read = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        read += value.byteLength;
        if (read > maxBytes) {
          const err = onExceeded();
          controller.error(err);
          await reader.cancel(err).catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** `fetch` whose every response body goes through limitBody. Body-less responses pass as is. */
export function withBodyLimit(
  fetch: FetchLike,
  maxBytes: number,
  onExceeded: () => Error,
): FetchLike {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (!res.body) return res;
    return new Response(limitBody(res.body, maxBytes, onExceeded), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
