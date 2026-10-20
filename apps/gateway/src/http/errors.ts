// Errors that map onto the contracts envelope. Route code throws these; the one error handler in
// server.ts turns them into `{ error: { code, message } }` with the contracts HTTP status.
import { httpStatusFor, type ErrorCode } from '@urumi/contracts';
import type { z } from 'zod';

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = httpStatusFor(code);
  }
}

export const unauthenticated = () => new HttpError('UNAUTHENTICATED', 'Not signed in');
export const forbidden = (message = 'Not allowed') => new HttpError('FORBIDDEN', message);
export const notFound = (what: string) => new HttpError('NOT_FOUND', `${what} not found`);
export const conflict = (message: string) => new HttpError('CONFLICT', message);

/**
 * Parses `value` with a contracts schema or throws VALIDATION_FAILED. The message names the
 * offending fields only; input values are never echoed.
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || 'body'))];
  throw new HttpError('VALIDATION_FAILED', `Invalid request: ${fields.join(', ')}`);
}
