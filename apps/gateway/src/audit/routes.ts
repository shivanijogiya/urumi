// GET /api/audit. Admins see every row and may filter by user; a member's `userId` is replaced by
// their own id (not a 403), so members only ever see their own calls.
import { AuditQuerySchema, ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { currentUser, requireSession } from '../auth/session.js';
import { parse } from '../http/errors.js';
import { decodeCursor, listAudit } from './repo.js';

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get(ROUTES.listAudit.path, { preHandler: requireSession }, async (req) => {
    const { cursor, ...query } = parse(AuditQuerySchema, req.query);
    const user = currentUser(req);
    return listAudit(app.pool, {
      ...query,
      userId: user.role === 'admin' ? query.userId : user.id,
      cursor: cursor === undefined ? undefined : decodeCursor(cursor),
    });
  });
}
