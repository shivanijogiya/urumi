import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('gateway', () => {
  it('exports its package name', () => {
    expect(name).toBe('gateway');
  });
});
