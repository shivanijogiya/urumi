import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('contracts', () => {
  it('exports its package name', () => {
    expect(name).toBe('contracts');
  });
});
