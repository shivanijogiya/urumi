import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  MAX_QUALIFIED_LEN,
  parseQualifiedName,
  qualifyToolName,
  SLUG_RE,
} from '../src/index.js';

const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('qualifyToolName / parseQualifiedName', () => {
  it('round-trips slug and tool', () => {
    const name = qualifyToolName('woo', 'list_orders');
    expect(name).toBe('woo__list_orders');
    expect(parseQualifiedName(name)).toEqual({ slug: 'woo', toolPart: 'list_orders' });
  });

  it('keeps same-named tools on different servers distinct', () => {
    expect(qualifyToolName('a', 'search')).not.toBe(qualifyToolName('b', 'search'));
  });

  it('splits on the first separator so tool parts may contain __', () => {
    expect(parseQualifiedName('git__a__b')).toEqual({ slug: 'git', toolPart: 'a__b' });
  });

  it.each(['Woo', 'my_slug', '-woo', 'woo-', 'a'.repeat(21), ''])('rejects slug %j', (slug) => {
    expect(SLUG_RE.test(slug)).toBe(false);
    expect(() => qualifyToolName(slug, 'x')).toThrow();
  });

  it.each(['woo', 'a', 'my-server-2', 'a'.repeat(20)])('accepts slug %j', (slug) => {
    expect(SLUG_RE.test(slug)).toBe(true);
  });

  it.each([
    ['get-sum', 'get-sum'],
    ['foo.bar', 'foo_bar'],
    ['ünïcode tool', '_n_code_tool'],
  ])('sanitizes %j to %j', (tool, expected) => {
    expect(qualifyToolName('s', tool)).toBe(`s__${expected}`);
  });

  it('returns null for names that are not qualified', () => {
    for (const bad of ['plain', '__tool', 'woo__', 'Bad__tool']) {
      expect(parseQualifiedName(bad)).toBeNull();
    }
  });

  it('shortens long names deterministically, uniquely, and within the Claude pattern', () => {
    const slug = 'a'.repeat(20);
    const long1 = 'x'.repeat(80) + 'one';
    const long2 = 'x'.repeat(80) + 'two';
    const q1 = qualifyToolName(slug, long1);
    expect(q1.length).toBeLessThanOrEqual(MAX_QUALIFIED_LEN);
    expect(q1).toMatch(CLAUDE_TOOL_NAME);
    expect(qualifyToolName(slug, long1)).toBe(q1);
    expect(qualifyToolName(slug, long2)).not.toBe(q1);
    expect(parseQualifiedName(q1)?.slug).toBe(slug);
    expect(q1.endsWith(`_${fnv1a32(long1)}`)).toBe(true);
  });
});

describe('fnv1a32', () => {
  it.each([
    ['', '811c9dc5'],
    ['a', 'e40c292c'],
    ['foobar', 'bf9cf968'],
  ])('matches the reference vector for %j', (input, hex) => {
    expect(fnv1a32(input)).toBe(hex);
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // A code-unit hash would treat 'é' as [0xc3, 0xa9]'s lookalike 'Ã©'; UTF-8 hashing does not.
    expect(fnv1a32('é')).not.toBe(fnv1a32('Ã©'));
    expect(fnv1a32('é')).toMatch(/^[0-9a-f]{8}$/);
  });
});
