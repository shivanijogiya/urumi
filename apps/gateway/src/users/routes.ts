// Admin-only member management: list, create (one-time temp password), update role/name/disabled.
import { randomBytes } from 'node:crypto';
import { CreateUserRequestSchema, ROUTES, UpdateUserRequestSchema } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { currentUser, requireAdmin } from '../auth/session.js';
import { withTransaction } from '../db/tx.js';
import { conflict, forbidden, notFound, parse } from '../http/errors.js';
import { deleteUserSessions, insertUser, listUsers, lockActiveAdmins, updateUser } from './repo.js';

export const UserParamsSchema = z.object({ id: z.uuid() });

export function registerUserRoutes(app: FastifyInstance): void {
  const { pool } = app;

  app.get(ROUTES.listUsers.path, { preHandler: requireAdmin }, async () => ({
    users: await listUsers(pool),
  }));

  app.post(ROUTES.createUser.path, { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(CreateUserRequestSchema, req.body);
    // 16 random bytes; returned once, stored only as a scrypt hash.
    const tempPassword = randomBytes(16).toString('base64url');
    const user = await insertUser(pool, {
      ...body,
      passwordHash: await hashPassword(tempPassword),
    });
    if (!user) throw conflict('A user with this email already exists');
    return reply.code(201).send({ user, tempPassword });
  });

  app.patch(ROUTES.updateUser.path, { preHandler: requireAdmin }, async (req) => {
    const { id } = parse(UserParamsSchema, req.params);
    const patch = parse(UpdateUserRequestSchema, req.body);
    const me = currentUser(req);
    const removesAdmin = patch.role === 'member' || patch.disabled === true;
    if (id === me.id && removesAdmin) {
      throw conflict('You cannot demote or disable your own account');
    }

    return withTransaction(pool, async (tx) => {
      if (removesAdmin) {
        // Row locks on all active admins serialise concurrent demotions, so two admins demoting
        // each other cannot both succeed.
        const admins = await lockActiveAdmins(tx);
        if (!admins.includes(me.id)) throw forbidden('Admins only');
        if (admins.includes(id) && admins.length <= 1) {
          throw conflict('Cannot remove the last active admin');
        }
      }
      const user = await updateUser(tx, id, patch);
      if (!user) throw notFound('User');
      if (patch.disabled === true) await deleteUserSessions(tx, id);
      return { user };
    });
  });
}
