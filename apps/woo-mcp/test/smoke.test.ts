import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('woo-mcp', () => {
  it('exports its package name', () => {
    expect(name).toBe('woo-mcp');
  });
});
