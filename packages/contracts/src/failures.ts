// Failure reasons (ADR 011): one classification of the gateway's fixed-vocabulary failure details
// (UpstreamError.detail in the gateway, stored as upstreams.last_error and audit_log.error_detail),
// shared by the gateway (metrics, API) and the dashboard (labels). Pure and browser-safe.
import { z } from 'zod';

export const FAILURE_REASONS = [
  'timeout',
  'dns',
  'connection_refused',
  'connection_failed',
  'http_status',
  'mcp_error',
  'blocked_address',
  'tool_error',
  'result_too_large',
  'not_permitted',
  'unknown_tool',
  'server_disabled',
  'server_down',
  'rate_limited',
  'invalid_arguments',
  'other',
] as const;
export const FailureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/** The gateway's own fixed details for failures that are not upstream transport errors. */
export const FAILURE_DETAILS = {
  toolError: 'Tool returned an error',
  resultTooLarge: 'Result too large',
  notPermitted: 'Not permitted',
  unknownTool: 'Unknown tool',
  serverDisabled: 'Server disabled',
  serverDown: 'Server marked down by the health check',
  invalidArguments: 'Invalid arguments',
  rateLimitedKey: 'Rate limit exceeded (API key)',
  rateLimitedUser: 'Rate limit exceeded (user)',
} as const;

const RULES: [RegExp, FailureReason][] = [
  [/^Timed out$/, 'timeout'],
  [/^Host did not resolve$|\((ENOTFOUND|EAI_AGAIN)\)$/, 'dns'],
  [/\(ECONNREFUSED\)$/, 'connection_refused'],
  [/^Connection failed \(E[A-Z_]+\)$/, 'connection_failed'],
  [/^HTTP \d{3}$/, 'http_status'],
  [/^MCP error -?\d+$/, 'mcp_error'],
  [/^Address not allowed$/, 'blocked_address'],
  [/^Tool returned an error$/, 'tool_error'],
  [/^Result too large$/, 'result_too_large'],
  [/^Not permitted$/, 'not_permitted'],
  [/^Unknown tool$/, 'unknown_tool'],
  [/^Server disabled$/, 'server_disabled'],
  [/^Server marked down/, 'server_down'],
  [/^Rate limit exceeded/, 'rate_limited'],
  [/^Invalid arguments$/, 'invalid_arguments'],
];

/** Reason of a stored detail; null for no detail (no failure). */
export function classifyFailure(detail: string | null | undefined): FailureReason | null {
  if (!detail) return null;
  for (const [re, reason] of RULES) if (re.test(detail)) return reason;
  return 'other';
}

const LABELS: Record<FailureReason, string> = {
  timeout: 'timed out',
  dns: 'host name did not resolve (DNS)',
  connection_refused: 'connection refused',
  connection_failed: 'connection failed',
  http_status: 'HTTP error status',
  mcp_error: 'MCP protocol error',
  blocked_address: 'address blocked by the SSRF guard',
  tool_error: 'the tool reported an error',
  result_too_large: 'result too large',
  not_permitted: 'not permitted for this user',
  unknown_tool: 'unknown tool',
  server_disabled: 'server disabled by an admin',
  server_down: 'server marked down by the health check',
  rate_limited: 'rate limited',
  invalid_arguments: 'invalid arguments',
  other: 'unexpected failure',
};

/** Human label, e.g. `connection refused (Connection failed (ECONNREFUSED))` → short form. */
export function describeFailure(detail: string | null | undefined): string | null {
  const reason = classifyFailure(detail);
  if (!reason) return null;
  // The detail adds the specifics (status code, errno) where the label does not.
  const specific =
    reason === 'http_status' || reason === 'mcp_error' || reason === 'connection_failed';
  return specific ? `${LABELS[reason]}: ${detail}` : LABELS[reason];
}
