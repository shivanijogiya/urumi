// Dashboard sessions. The browser holds a random 32-byte token in the httpOnly cookie
// `urumi_session`; the database holds only sha256hex(token) as sessions.id, so a database leak
// does not yield usable cookies. Every request re-reads the user, so a role change, disable, or
// logout takes effect on the next request.
import { createHash, randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type User } from '@urumi/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { forbidden, unauthenticated } from '../http/errors.js';
import { deleteSession, findSession, insertSession } from '../users/repo.js';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    cookieSecure: boolean;
  }
  interface FastifyRequest {
    /** Set by requireSession / requireAdmin. */
    user: User | null;
    /** sessions.id (the token hash) of the current request, set by requireSession. */
    sessionId: string | null;
  }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a session row and returns the cookie token (shown to the browser only). */
export async function createSession(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await insertSession(pool, {
    id: hashSessionToken(token),
    userId,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  return token;
}

function cookieAttributes(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; ${cookieAttributes(reply.server.cookieSecure)}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(reply.server.cookieSecure)}`,
  );
}

/** The session token from the Cookie header, if it is well-formed. */
export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * preHandler: 401 unless the cookie names a live session of an enabled user. Expired sessions are
 * deleted on sight. Sets `request.user` and `request.sessionId`.
 */
export async function requireSession(request: FastifyRequest): Promise<void> {
  const token = readSessionToken(request.headers.cookie);
  if (!token) throw unauthenticated();
  const id = hashSessionToken(token);
  const pool = request.server.pool;
  const found = await findSession(pool, id);
  if (!found) throw unauthenticated();
  if (found.expired) {
    await deleteSession(pool, id);
    throw unauthenticated();
  }
  if (found.user.disabledAt) throw unauthenticated();
  request.user = found.user;
  request.sessionId = id;
}

/** preHandler: requireSession, then 403 unless the user is an admin. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireSession(request);
  if (request.user?.role !== 'admin') throw forbidden('Admins only');
}

/** The signed-in user in a handler behind requireSession / requireAdmin. */
export function currentUser(request: FastifyRequest): User {
  if (!request.user) throw unauthenticated();
  return request.user;
}
