import { describe, expect, it } from 'vitest';
import { MCP_TIMEOUTS, qualifyToolName, WOO_TOOLS } from '../src/index.js';

describe('mcp constants', () => {
  it('every woo tool qualifies without sanitization or shortening', () => {
    for (const tool of WOO_TOOLS) expect(qualifyToolName('woo', tool)).toBe(`woo__${tool}`);
  });

  it('list timeout is shorter than call timeout', () => {
    expect(MCP_TIMEOUTS.listMs).toBeLessThan(MCP_TIMEOUTS.callMs);
  });
});
