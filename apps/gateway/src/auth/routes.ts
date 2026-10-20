// /api/auth/*: login, logout, me, change password.
import { ChangePasswordRequestSchema, LoginRequestSchema, ROUTES } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db/tx.js';
import { HttpError, parse, unauthenticated } from '../http/errors.js';
import {
  deleteSession,
  deleteUserSessions,
  findUserWithPassword,
  setPasswordHash,
} from '../users/repo.js';
import type { LoginLimiter } from './login-limiter.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  clearSessionCookie,
  createSession,
  currentUser,
  requireSession,
  setSessionCookie,
} from './session.js';

/** One answer for every failed login: wrong password, unknown email, disabled, or throttled. */
const loginFailed = () => new HttpError('UNAUTHENTICATED', 'Invalid email or password');

// Verified against when the email is unknown, so that path costs one scrypt like a real check.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

export interface LoginLimiters {
  email: LoginLimiter;
  ip: LoginLimiter;
}

export function registerAuthRoutes(app: FastifyInstance, limiters: LoginLimiters): void {
  const { pool } = app;

  /**
   * Counts the attempt against the client IP and the email before any scrypt runs (see
   * login-limiter.ts). An IP that is already blocked does not add to the email's count.
   */
  const acquire = (ip: string, email: string) =>
    limiters.ip.tryAcquire(ip) && limiters.email.tryAcquire(email);
  const succeeded = (ip: string, email: string) => {
    limiters.email.recordSuccess(email);
    limiters.ip.release(ip);
  };
  // Hash it now, so the first unknown-email login does not pay for two scrypt runs.
  void getDummyHash();

  app.post(ROUTES.login.path, async (req, reply) => {
    const { email, password } = parse(LoginRequestSchema, req.body);
    if (!acquire(req.ip, email)) throw loginFailed();

    const found = await findUserWithPassword(pool, { email });
    const ok = await verifyPassword(password, found?.passwordHash ?? (await getDummyHash()));
    if (!found || !ok || found.user.disabledAt) throw loginFailed();
    succeeded(req.ip, email);

    setSessionCookie(reply, await createSession(pool, found.user.id));
    return { user: found.user };
  });

  app.post(ROUTES.logout.path, { preHandler: requireSession }, async (req, reply) => {
    await deleteSession(pool, req.sessionId!);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get(ROUTES.me.path, { preHandler: requireSession }, async (req) => ({
    user: currentUser(req),
  }));

  app.post(ROUTES.changePassword.path, { preHandler: requireSession }, async (req, reply) => {
    const { currentPassword, newPassword } = parse(ChangePasswordRequestSchema, req.body);
    const found = await findUserWithPassword(pool, { id: currentUser(req).id });
    if (!found) throw unauthenticated();
    const { user } = found;
    // Shares the login throttle, so a stolen session cannot brute-force the current password.
    // Not 401 on failure: the session is fine, and the dashboard treats 401 as "signed out".
    const wrongPassword = () => new HttpError('VALIDATION_FAILED', 'Current password is incorrect');
    if (!acquire(req.ip, user.email)) throw wrongPassword();
    if (!(await verifyPassword(currentPassword, found.passwordHash))) throw wrongPassword();
    succeeded(req.ip, user.email);
    const passwordHash = await hashPassword(newPassword);
    // New password and "sign out everywhere else" land together or not at all.
    await withTransaction(pool, async (tx) => {
      await setPasswordHash(tx, user.id, passwordHash);
      await deleteUserSessions(tx, user.id, req.sessionId!);
    });
    return reply.code(204).send();
  });
}
