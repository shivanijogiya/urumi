import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('dashboard', () => {
  it('exports its package name', () => {
    expect(name).toBe('dashboard');
  });
});
