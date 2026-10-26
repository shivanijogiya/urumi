import { describe, expect, it } from 'vitest';
import { classifyFailure, describeFailure, FAILURE_DETAILS } from '../src/index.js';

describe('classifyFailure (ADR 011)', () => {
  it.each([
    ['Timed out', 'timeout'],
    ['Host did not resolve', 'dns'],
    ['Connection failed (ENOTFOUND)', 'dns'],
    ['Connection failed (EAI_AGAIN)', 'dns'],
    ['Connection failed (ECONNREFUSED)', 'connection_refused'],
    ['Connection failed (ECONNRESET)', 'connection_failed'],
    ['HTTP 503', 'http_status'],
    ['MCP error -32603', 'mcp_error'],
    ['Address not allowed', 'blocked_address'],
    [FAILURE_DETAILS.toolError, 'tool_error'],
    [FAILURE_DETAILS.resultTooLarge, 'result_too_large'],
    [FAILURE_DETAILS.notPermitted, 'not_permitted'],
    [FAILURE_DETAILS.unknownTool, 'unknown_tool'],
    [FAILURE_DETAILS.serverDisabled, 'server_disabled'],
    [FAILURE_DETAILS.serverDown, 'server_down'],
    [FAILURE_DETAILS.rateLimitedKey, 'rate_limited'],
    [FAILURE_DETAILS.rateLimitedUser, 'rate_limited'],
    [FAILURE_DETAILS.invalidArguments, 'invalid_arguments'],
    ['Unexpected response', 'other'],
    ['Setup failed', 'other'],
  ])('%s → %s', (detail, reason) => {
    expect(classifyFailure(detail)).toBe(reason);
  });

  it('no detail is no failure', () => {
    expect(classifyFailure(null)).toBeNull();
    expect(classifyFailure('')).toBeNull();
    expect(describeFailure(undefined)).toBeNull();
  });

  it('labels keep the specifics where they matter', () => {
    expect(describeFailure('HTTP 502')).toBe('HTTP error status: HTTP 502');
    expect(describeFailure('Connection failed (ECONNREFUSED)')).toBe('connection refused');
    expect(describeFailure('Timed out')).toBe('timed out');
    expect(describeFailure('Host did not resolve')).toBe('host name did not resolve (DNS)');
  });
});
