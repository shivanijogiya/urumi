// API key routes. Self: /api/keys (own keys only). Admin: /api/users/:id/keys (any user's keys).
import { CreateKeyRequestSchema, ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateApiKey } from '../auth/api-keys.js';
import { currentUser, requireAdmin, requireSession } from '../auth/session.js';
import { notFound, parse } from '../http/errors.js';
import { findUser } from '../users/repo.js';
import { UserParamsSchema } from '../users/routes.js';
import { insertKey, listKeys, revokeKey } from './repo.js';

const KeyParamsSchema = z.object({ id: z.uuid() });
const UserKeyParamsSchema = z.object({ id: z.uuid(), keyId: z.uuid() });

export function registerKeyRoutes(app: FastifyInstance): void {
  const { pool } = app;

  app.get(ROUTES.listKeys.path, { preHandler: requireSession }, async (req) => ({
    keys: await listKeys(pool, currentUser(req).id),
  }));

  app.post(ROUTES.createKey.path, { preHandler: requireSession }, async (req, reply) => {
    const { name } = parse(CreateKeyRequestSchema, req.body);
    const { secret, prefix, hash } = generateApiKey();
    const key = await insertKey(pool, { userId: currentUser(req).id, name, prefix, hash });
    // The only time the secret leaves the server.
    return reply.code(201).send({ key, secret });
  });

  // Someone else's key is 404, not 403: key ids of other users are not confirmed to exist.
  app.delete(ROUTES.revokeKey.path, { preHandler: requireSession }, async (req, reply) => {
    const { id } = parse(KeyParamsSchema, req.params);
    if (!(await revokeKey(pool, currentUser(req).id, id))) throw notFound('Key');
    return reply.code(204).send();
  });

  app.get(ROUTES.listUserKeys.path, { preHandler: requireAdmin }, async (req) => {
    const { id } = parse(UserParamsSchema, req.params);
    if (!(await findUser(pool, id))) throw notFound('User');
    return { keys: await listKeys(pool, id) };
  });

  app.delete(ROUTES.revokeUserKey.path, { preHandler: requireAdmin }, async (req, reply) => {
    const { id, keyId } = parse(UserKeyParamsSchema, req.params);
    if (!(await revokeKey(pool, id, keyId))) throw notFound('Key');
    return reply.code(204).send();
  });
}
