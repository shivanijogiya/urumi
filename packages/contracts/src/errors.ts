import { z } from 'zod';

const STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  TOOL_NOT_FOUND: 404,
  UPSTREAM_DISABLED: 409,
  UPSTREAM_UNREACHABLE: 502,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  SSRF_BLOCKED: 400,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;
export const ERROR_CODES = Object.keys(STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/**
 * Every non-2xx gateway response body. `message` is shown to users: it must never contain upstream
 * URLs, credentials, stack traces, or raw upstream error text.
 */
export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

export function makeError(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
