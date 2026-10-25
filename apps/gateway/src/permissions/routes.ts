// Admin-only tool permission rules (ADR 008): list, upsert, delete. A change applies on the next
// tools/list or tools/call — the policy is read per request, never cached.
import { ROUTES, UpsertPermissionRequestSchema } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/session.js';
import { notFound, parse } from '../http/errors.js';
import { findUser } from '../users/repo.js';
import { deletePermission, listPermissions, upsertPermission } from './repo.js';

const ParamsSchema = z.object({ id: z.uuid() });

export function registerPermissionRoutes(app: FastifyInstance): void {
  const { pool } = app;

  app.get(ROUTES.listPermissions.path, { preHandler: requireAdmin }, async () => ({
    rules: await listPermissions(pool),
  }));

  app.post(ROUTES.upsertPermission.path, { preHandler: requireAdmin }, async (req) => {
    const body = parse(UpsertPermissionRequestSchema, req.body);
    if (body.userId && !(await findUser(pool, body.userId))) throw notFound('User');
    const rule = await upsertPermission(pool, body);
    req.log.info(
      {
        rule: {
          id: rule.id,
          role: rule.role,
          userId: rule.userId,
          server: rule.serverSlug,
          tool: rule.tool,
          effect: rule.effect,
        },
      },
      'tool permission set',
    );
    return { rule };
  });

  app.delete(ROUTES.deletePermission.path, { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parse(ParamsSchema, req.params);
    if (!(await deletePermission(pool, id))) throw notFound('Rule');
    req.log.info({ ruleId: id }, 'tool permission deleted');
    return reply.code(204).send();
  });
}
