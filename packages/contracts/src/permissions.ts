// Tool permissions (ADR 008): which tools a user may see and call. Browser-safe and pure, so the
// gateway (enforcement) and the dashboard (preview) evaluate rules with the same function.
//
// A rule = subject (a role, or one user) × server (`slug` or `*`) × tool pattern × effect.
// Tool pattern: `*` (every tool), `prefix*` (e.g. `list_*`) or an exact tool name, matched against
// the tool part of the qualified name `{slug}__{tool}` (what tools/list shows after the `__`).
//
// Evaluation for (user, role, slug, tool):
//   1. the user's own rules that match; if any, the most specific one decides
//   2. otherwise the role's rules that match; the most specific one decides
//   3. otherwise DENY (a tool nobody granted is hidden and rejected — e.g. a new upstream is
//      admin-only until an admin grants it to members)
// Specificity: an exact server beats `*`; then an exact tool beats a longer prefix beats a shorter
// prefix beats `*`. On a tie, deny wins.
import { z } from 'zod';
import { RoleSchema, type Role } from './api.js';
import { SLUG_RE } from './naming.js';

export const TOOL_PATTERN_RE = /^(?:\*|[A-Za-z0-9_-]{1,64}\*?)$/;
export const ANY = '*';

export const PermissionEffectSchema = z.enum(['allow', 'deny']);
const serverPattern = z.string().refine((s) => s === ANY || SLUG_RE.test(s), 'Invalid server');
const toolPattern = z.string().regex(TOOL_PATTERN_RE);

export const PermissionRuleSchema = z.object({
  id: z.uuid(),
  /** Exactly one of role / userId is set. */
  role: RoleSchema.nullable(),
  userId: z.uuid().nullable(),
  /** The user's email, for display; null for role rules. */
  userEmail: z.string().nullable(),
  serverSlug: z.string(),
  tool: z.string(),
  effect: PermissionEffectSchema,
  createdAt: z.iso.datetime(),
});
export const PermissionListResponseSchema = z.object({ rules: z.array(PermissionRuleSchema) });

/** Upsert: a rule with the same subject, server and tool has its effect replaced. */
export const UpsertPermissionRequestSchema = z
  .strictObject({
    role: RoleSchema.optional(),
    userId: z.uuid().optional(),
    serverSlug: serverPattern,
    tool: toolPattern,
    effect: PermissionEffectSchema,
  })
  .refine((r) => (r.role === undefined) !== (r.userId === undefined), {
    message: 'Exactly one of role or userId',
    path: ['role'],
  });
export const PermissionResponseSchema = z.object({ rule: PermissionRuleSchema });

export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type UpsertPermissionRequest = z.infer<typeof UpsertPermissionRequestSchema>;

/** The fields evaluation needs (rows from the DB or the API both fit). */
export interface RuleLike {
  role: Role | null;
  userId: string | null;
  serverSlug: string;
  tool: string;
  effect: PermissionEffect;
}

export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === ANY) return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** Higher = more specific. Exact server dominates; then exact tool > longer prefix > `*`. */
export function specificity(rule: Pick<RuleLike, 'serverSlug' | 'tool'>): number {
  const server = rule.serverSlug === ANY ? 0 : 1000;
  if (rule.tool === ANY) return server;
  if (rule.tool.endsWith('*')) return server + rule.tool.length; // ≤ 65
  return server + 100;
}

function decide(rules: RuleLike[], slug: string, tool: string): PermissionEffect | null {
  let best: RuleLike | null = null;
  for (const r of rules) {
    if ((r.serverSlug !== ANY && r.serverSlug !== slug) || !toolMatches(r.tool, tool)) continue;
    if (
      !best ||
      specificity(r) > specificity(best) ||
      (specificity(r) === specificity(best) && r.effect === 'deny')
    ) {
      best = r;
    }
  }
  return best?.effect ?? null;
}

export interface Subject {
  userId: string;
  role: Role;
}

/** True if `subject` may list and call `{slug}__{tool}` under `rules` (see the header). */
export function isToolAllowed(
  rules: readonly RuleLike[],
  subject: Subject,
  slug: string,
  tool: string,
): boolean {
  const own = rules.filter((r) => r.userId !== null && r.userId === subject.userId);
  const byRole = rules.filter((r) => r.userId === null && r.role === subject.role);
  return (decide(own, slug, tool) ?? decide(byRole, slug, tool)) === 'allow';
}
