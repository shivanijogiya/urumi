// Discovery mode ranking (ADR 012): BM25 over permitted tools, pure (no DB).
import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../src/core/registry.js';
import { tokenize, ToolIndex } from '../src/discovery/search.js';
import { syntheticTools } from './helpers/synthetic-tools.js';

function reg(slug: string, name: string, description = ''): RegisteredTool {
  return {
    name: `${slug}__${name}`,
    serverSlug: slug,
    upstreamId: slug,
    originalName: name,
    description,
    inputSchema: { type: 'object' },
  };
}

const WOO = [
  reg('woo', 'list_orders', 'Lists WooCommerce orders filtered by status and by creation date'),
  reg('woo', 'update_order_status', 'Changes the status of one order (processing, completed …)'),
  reg('woo', 'list_products', 'Lists WooCommerce products, optionally filtered by search text'),
  reg('woo', 'create_product', 'Creates a simple WooCommerce product and returns its id'),
];
const GITLAB = [
  reg('gitlab', 'list_merge_requests', 'List or search merge requests in a GitLab project'),
  reg('gitlab', 'get_merge_request', 'Get a merge request and optionally its diffs'),
  reg('gitlab', 'list_pipelines', 'List all project pipelines'),
];
const SYNTH = syntheticTools().map((t) => reg('synth', t.name, t.description));
const ALL = [...WOO, ...GITLAB, ...SYNTH];

describe('tokenize', () => {
  it('splits snake, kebab and camel case, lowercases, drops stopwords, strips plurals', () => {
    expect(tokenize('list_orders')).toEqual(['list', 'order']);
    expect(tokenize('get-mergeRequest')).toEqual(['merge', 'request']);
    expect(tokenize('Show me the categories of the store')).toEqual(['show', 'category', 'store']);
    expect(tokenize('status')).toEqual(['status']);
  });
});

describe('ToolIndex.search', () => {
  const index = new ToolIndex(ALL);

  it('indexes 100+ tools', () => {
    expect(index.size).toBeGreaterThanOrEqual(120);
  });

  it.each([
    ['woocommerce orders by creation date', 'woo__list_orders'],
    ['change the status of an order', 'woo__update_order_status'],
    ['refund a payment', 'synth__refund_payment'],
    ['gift card', 'synth__issue_gift_card'],
    ['list or search merge requests', 'gitlab__list_merge_requests'],
    ['translate', 'synth__translate_text'],
    ['create a woocommerce product', 'woo__create_product'],
  ])('%s → %s first', (query, expected) => {
    expect(index.search(query, 5)[0]?.tool.name).toBe(expected);
  });

  it('an exact tool name or tool part wins', () => {
    expect(index.search('woo__list_products', 3)[0]!.tool.name).toBe('woo__list_products');
    expect(index.search('list_pipelines', 3)[0]!.tool.name).toBe('gitlab__list_pipelines');
  });

  it('respects the limit, returns nothing for no match, and is deterministic', () => {
    expect(index.search('order', 3)).toHaveLength(3);
    expect(index.search('zzzqqq', 5)).toEqual([]);
    expect(index.search('', 5)).toEqual([]);
    const a = index.search('export reports', 10).map((h) => h.tool.name);
    const b = new ToolIndex([...ALL].reverse())
      .search('export reports', 10)
      .map((h) => h.tool.name);
    expect(a).toEqual(b);
    expect(a[0]).toBe('synth__export_reports');
  });

  it('only ever returns tools it was given (the caller passes permitted tools only)', () => {
    const memberOnly = new ToolIndex(WOO.filter((t) => !t.name.includes('create')));
    expect(memberOnly.search('create product', 5).map((h) => h.tool.name)).not.toContain(
      'woo__create_product',
    );
  });
});
