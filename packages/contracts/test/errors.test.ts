import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ErrorEnvelopeSchema, httpStatusFor, makeError } from '../src/index.js';

describe('errors', () => {
  it.each(ERROR_CODES)('%s maps to an HTTP error status', (code) => {
    const status = httpStatusFor(code);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
  });

  it('maps representative codes', () => {
    expect(httpStatusFor('UNAUTHENTICATED')).toBe(401);
    expect(httpStatusFor('TOOL_NOT_FOUND')).toBe(404);
    expect(httpStatusFor('UPSTREAM_TIMEOUT')).toBe(504);
  });

  it('makeError output parses as an envelope', () => {
    const env = makeError('UPSTREAM_TIMEOUT', 'Upstream did not respond in time');
    expect(ErrorEnvelopeSchema.parse(env)).toEqual({
      error: { code: 'UPSTREAM_TIMEOUT', message: 'Upstream did not respond in time' },
    });
  });

  it('rejects unknown codes and extra fields', () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
    const extra = { error: { code: 'INTERNAL', message: 'x', stack: 'at ...' } };
    expect(ErrorEnvelopeSchema.safeParse(extra).success).toBe(false);
  });
});
