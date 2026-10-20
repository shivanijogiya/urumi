// POST /api/chat (#19): session required (CSRF guard applies, see http/csrf.ts), per-user rate
// limit, then one stateless tool loop (service.ts).
import { ChatRequestSchema, makeError, ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { currentUser, requireSession } from '../auth/session.js';
import { parse } from '../http/errors.js';
import type { ChatRateLimiter } from './rate-limit.js';
import { checkHistory, type ChatService } from './service.js';

export function registerChatRoutes(
  app: FastifyInstance,
  deps: { service: ChatService | null; limiter: ChatRateLimiter },
): void {
  app.post(ROUTES.chat.path, { preHandler: requireSession }, async (req, reply) => {
    const user = currentUser(req);
    // No ANTHROPIC_API_KEY: chat is off, the rest of the gateway is not. No 503 code in the
    // contracts table, so INTERNAL with 503 (as /readyz does).
    if (!deps.service) {
      return reply.code(503).send(makeError('INTERNAL', 'Chat is not configured'));
    }
    const { messages } = parse(ChatRequestSchema, req.body);
    checkHistory(messages);
    // No 429 code in the contracts table: VALIDATION_FAILED with HTTP 429.
    if (!deps.limiter.tryAcquire(user.id)) {
      return reply
        .code(429)
        .header('retry-after', '60')
        .send(makeError('VALIDATION_FAILED', 'Too many chat requests, try again in a minute'));
    }
    return deps.service.chat(user, messages, req.log);
  });
}
