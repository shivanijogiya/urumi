import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db.js';
import {
  isToolAllowed,
  PermissionRuleSchema,
  ROUTES,
  specificity,
  TOOL_PATTERN_RE,
  toolMatches,
  UpsertPermissionRequestSchema,
  type RuleLike,
} from '../src/index.js';

const uuid = '6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const other = '0b8e0c6a-1d2f-4a3b-9c8d-7e6f5a4b3c2d';
const role = (r: 'admin' | 'member', serverSlug: string, tool: string, effect: 'allow' | 'deny') =>
  ({ role: r, userId: null, serverSlug, tool, effect }) satisfies RuleLike;
const user = (userId: string, serverSlug: string, tool: string, effect: 'allow' | 'deny') =>
  ({ role: null, userId, serverSlug, tool, effect }) satisfies RuleLike;
const member = { userId: uuid, role: 'member' as const };
const admin = { userId: other, role: 'admin' as const };

/** The rules 002_tool_permissions.sql seeds, parsed from the file itself. */
function seededRules(): RuleLike[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, '002_tool_permissions.sql'), 'utf8');
  return [...sql.matchAll(/\('(admin|member)',\s*'([^']+)',\s*'([^']+)',\s*'(allow|deny)'\)/g)].map(
    (m) => role(m[1] as 'admin' | 'member', m[2]!, m[3]!, m[4] as 'allow' | 'deny'),
  );
}

describe('tool patterns', () => {
  it('matches *, prefix* and exact names', () => {
    expect(toolMatches('*', 'anything')).toBe(true);
    expect(toolMatches('list_*', 'list_orders')).toBe(true);
    expect(toolMatches('list_*', 'get_order')).toBe(false);
    expect(toolMatches('get_order', 'get_order')).toBe(true);
    expect(toolMatches('get_order', 'get_orders')).toBe(false);
  });

  it('accepts only *, prefix* or a qualified-name tool part', () => {
    for (const ok of ['*', 'list_*', 'get-env', 'create_product']) {
      expect(TOOL_PATTERN_RE.test(ok)).toBe(true);
    }
    for (const bad of ['', '**', 'a*b', 'list orders', "x';--", '*list']) {
      expect(TOOL_PATTERN_RE.test(bad)).toBe(false);
    }
  });

  it('orders specificity: exact server > *, then exact tool > longer prefix > shorter > *', () => {
    const s = (serverSlug: string, tool: string) => specificity({ serverSlug, tool });
    expect(s('woo', '*')).toBeGreaterThan(s('*', 'list_orders'));
    expect(s('woo', 'list_orders')).toBeGreaterThan(s('woo', 'list_order*'));
    expect(s('woo', 'list_order*')).toBeGreaterThan(s('woo', 'list_*'));
    expect(s('woo', 'list_*')).toBeGreaterThan(s('woo', '*'));
  });
});

describe('isToolAllowed', () => {
  it('denies when no rule matches (default deny)', () => {
    expect(isToolAllowed([], member, 'woo', 'list_orders')).toBe(false);
    expect(isToolAllowed([role('admin', '*', '*', 'allow')], member, 'woo', 'x')).toBe(false);
  });

  it('the most specific role rule wins', () => {
    const rules = [role('member', 'woo', '*', 'deny'), role('member', 'woo', 'list_*', 'allow')];
    expect(isToolAllowed(rules, member, 'woo', 'list_orders')).toBe(true);
    expect(isToolAllowed(rules, member, 'woo', 'create_product')).toBe(false);
  });

  it('deny wins a tie', () => {
    const rules = [
      role('member', 'woo', 'get_order', 'allow'),
      role('member', 'woo', 'get_order', 'deny'),
    ];
    expect(isToolAllowed(rules, member, 'woo', 'get_order')).toBe(false);
  });

  it("a user's own rules override the role's, in both directions", () => {
    const rules = [
      role('member', 'woo', 'list_orders', 'allow'),
      user(uuid, 'woo', 'create_product', 'allow'),
      user(uuid, 'woo', 'list_orders', 'deny'),
    ];
    expect(isToolAllowed(rules, member, 'woo', 'create_product')).toBe(true);
    expect(isToolAllowed(rules, member, 'woo', 'list_orders')).toBe(false);
    // Another member is unaffected by uuid's overrides.
    const m2 = { userId: other, role: 'member' as const };
    expect(isToolAllowed(rules, m2, 'woo', 'create_product')).toBe(false);
    expect(isToolAllowed(rules, m2, 'woo', 'list_orders')).toBe(true);
  });

  it('the seeded default: members read-only, admins everything', () => {
    const rules = seededRules();
    expect(rules.length).toBeGreaterThan(10);
    for (const t of ['list_products', 'list_orders', 'get_order']) {
      expect(isToolAllowed(rules, member, 'woo', t)).toBe(true);
    }
    for (const t of ['create_product', 'update_order_status']) {
      expect(isToolAllowed(rules, member, 'woo', t)).toBe(false);
      expect(isToolAllowed(rules, admin, 'woo', t)).toBe(true);
    }
    expect(isToolAllowed(rules, member, 'everything', 'echo')).toBe(true);
    expect(isToolAllowed(rules, member, 'everything', 'get-env')).toBe(false);
    expect(isToolAllowed(rules, member, 'gitlab', 'get_merge_request')).toBe(true);
    expect(isToolAllowed(rules, member, 'gitlab', 'list_pipelines')).toBe(true);
    expect(isToolAllowed(rules, member, 'gitlab', 'create_issue')).toBe(false);
    expect(isToolAllowed(rules, member, 'gitlab', 'save_merge_request')).toBe(false);
    // A newly added upstream is admin-only until someone grants it.
    expect(isToolAllowed(rules, member, 'newserver', 'list_things')).toBe(false);
    expect(isToolAllowed(rules, admin, 'newserver', 'list_things')).toBe(true);
  });
});

describe('permission API schemas', () => {
  const ok = (v: unknown) => UpsertPermissionRequestSchema.safeParse(v).success;

  it('needs exactly one subject', () => {
    const base = { serverSlug: 'woo', tool: 'create_product', effect: 'allow' };
    expect(ok({ ...base, role: 'member' })).toBe(true);
    expect(ok({ ...base, userId: uuid })).toBe(true);
    expect(ok(base)).toBe(false);
    expect(ok({ ...base, role: 'member', userId: uuid })).toBe(false);
  });

  it('validates server, tool and effect, and rejects unknown fields', () => {
    const base = { role: 'member', serverSlug: 'woo', tool: 'list_*', effect: 'deny' };
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, serverSlug: '*' })).toBe(true);
    expect(ok({ ...base, serverSlug: 'Woo' })).toBe(false);
    expect(ok({ ...base, tool: 'a*b' })).toBe(false);
    expect(ok({ ...base, effect: 'maybe' })).toBe(false);
    expect(ok({ ...base, role: 'owner' })).toBe(false);
    expect(ok({ ...base, extra: 1 })).toBe(false);
  });

  it('describes a rule and its routes', () => {
    const rule = {
      id: uuid,
      role: null,
      userId: other,
      userEmail: 'a@example.com',
      serverSlug: 'woo',
      tool: 'create_product',
      effect: 'allow',
      createdAt: new Date().toISOString(),
    };
    expect(PermissionRuleSchema.safeParse(rule).success).toBe(true);
    expect(ROUTES.listPermissions).toEqual({
      method: 'GET',
      path: '/api/permissions',
      auth: 'admin',
    });
    expect(ROUTES.upsertPermission.auth).toBe('admin');
    expect(ROUTES.deletePermission.auth).toBe('admin');
  });
});
