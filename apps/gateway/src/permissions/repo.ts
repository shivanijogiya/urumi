// SQL for tool_permissions (002_tool_permissions.sql) and the per-user policy check used by
// callTool and every tool list (ADR 008). Evaluation itself is the contracts' isToolAllowed.
import {
  isToolAllowed,
  type PermissionRule,
  type Role,
  type RuleLike,
  type UpsertPermissionRequest,
} from '@urumi/contracts';
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

interface RuleRow {
  id: string;
  role: Role | null;
  user_id: string | null;
  user_email: string | null;
  server_slug: string;
  tool: string;
  effect: 'allow' | 'deny';
  created_at: Date;
}

const COLUMNS = `p.id, p.role, p.user_id, u.email AS user_email, p.server_slug, p.tool, p.effect,
  p.created_at`;

function toRule(r: RuleRow): PermissionRule {
  return {
    id: r.id,
    role: r.role,
    userId: r.user_id,
    userEmail: r.user_email,
    serverSlug: r.server_slug,
    tool: r.tool,
    effect: r.effect,
    createdAt: r.created_at.toISOString(),
  };
}

/** All rules: role rules first (admin, member), then per-user; each by server and tool. */
export async function listPermissions(db: Db): Promise<PermissionRule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ${COLUMNS} FROM tool_permissions p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.user_id IS NOT NULL, p.role, u.email, p.server_slug, p.tool`,
  );
  return rows.map(toRule);
}

/** Insert, or replace the effect of the rule with the same subject, server and tool. */
export async function upsertPermission(
  db: Db,
  req: UpsertPermissionRequest,
): Promise<PermissionRule> {
  const conflict = req.role
    ? '(role, server_slug, tool) WHERE role IS NOT NULL'
    : '(user_id, server_slug, tool) WHERE user_id IS NOT NULL';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO tool_permissions (role, user_id, server_slug, tool, effect)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ${conflict} DO UPDATE SET effect = EXCLUDED.effect
     RETURNING id`,
    [req.role ?? null, req.userId ?? null, req.serverSlug, req.tool, req.effect],
  );
  const { rows: full } = await db.query<RuleRow>(
    `SELECT ${COLUMNS} FROM tool_permissions p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [rows[0]!.id],
  );
  return toRule(full[0]!);
}

export async function deletePermission(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM tool_permissions WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/** What a user may see and call. A missing or disabled user may do nothing. */
export interface ToolPolicy {
  allows(serverSlug: string, tool: string): boolean;
}

const DENY_ALL: ToolPolicy = { allows: () => false };

/**
 * Loads the rules that can apply to `userId` (its role's and its own) in one query. Called per
 * request — tools/list, tools/call, chat turn — so a policy edit applies on the next request.
 */
export async function loadToolPolicy(db: Db, userId: string): Promise<ToolPolicy> {
  const { rows } = await db.query<{ user_role: Role; disabled: boolean } & Partial<RuleRow>>(
    `SELECT u.role AS user_role, u.disabled_at IS NOT NULL AS disabled,
            p.role, p.user_id, p.server_slug, p.tool, p.effect
     FROM users u
     LEFT JOIN tool_permissions p ON p.role = u.role OR p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const first = rows[0];
  if (!first || first.disabled) return DENY_ALL;
  const rules: RuleLike[] = rows
    .filter((r) => r.effect)
    .map((r) => ({
      role: r.role ?? null,
      userId: r.user_id ?? null,
      serverSlug: r.server_slug!,
      tool: r.tool!,
      effect: r.effect!,
    }));
  const subject = { userId, role: first.user_role };
  return { allows: (slug, tool) => isToolAllowed(rules, subject, slug, tool) };
}
