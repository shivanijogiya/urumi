// SQL for users and sessions. Parameterized queries only; rows are mapped to the contracts shapes.
import type { Role, User } from '@urumi/contracts';
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: Date;
  disabled_at: Date | null;
}

export const USER_COLUMNS = 'u.id, u.email, u.name, u.role, u.created_at, u.disabled_at';

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null,
  };
}

export async function listUsers(db: Db): Promise<User[]> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users u ORDER BY u.created_at, u.email`,
  );
  return rows.map(toUser);
}

export async function findUser(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [
    id,
  ]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserWithPassword(
  db: Db,
  by: { email: string } | { id: string },
): Promise<{ user: User; passwordHash: string } | null> {
  const [column, value] = 'email' in by ? ['email', by.email] : ['id', by.id];
  const { rows } = await db.query<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, u.password_hash FROM users u WHERE u.${column} = $1`,
    [value],
  );
  const row = rows[0];
  return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
}

/** Returns null when the email is already taken. */
export async function insertUser(
  db: Db,
  user: { email: string; name: string; role: Role; passwordHash: string },
): Promise<User | null> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users AS u (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [user.email, user.name, user.role, user.passwordHash],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

/** Applies only the given fields. `disabled: true` keeps an existing disabled_at. */
export async function updateUser(
  db: Db,
  id: string,
  patch: { name?: string; role?: Role; disabled?: boolean },
): Promise<User | null> {
  const { rows } = await db.query<UserRow>(
    `UPDATE users AS u SET
       name = COALESCE($2, u.name),
       role = COALESCE($3, u.role),
       disabled_at = CASE WHEN $4::boolean IS NULL THEN u.disabled_at
                          WHEN $4::boolean THEN COALESCE(u.disabled_at, now())
                          ELSE NULL END
     WHERE u.id = $1
     RETURNING ${USER_COLUMNS}`,
    [id, patch.name ?? null, patch.role ?? null, patch.disabled ?? null],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function setPasswordHash(db: Db, id: string, passwordHash: string): Promise<void> {
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
}

/**
 * Locks every active admin row (in id order, so concurrent callers cannot deadlock) and returns
 * their ids. Call inside a transaction before a change that could remove an admin.
 */
export async function lockActiveAdmins(client: pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY id FOR UPDATE`,
  );
  return rows.map((r) => r.id);
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────
export async function insertSession(
  db: Db,
  session: { id: string; userId: string; ttlSeconds: number },
): Promise<void> {
  // Housekeeping: the user's expired sessions go when they sign in again.
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [
    session.userId,
  ]);
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [session.id, session.userId, session.ttlSeconds],
  );
}

/** The session's user, or null. `expired` is decided by the database clock. */
export async function findSession(
  db: Db,
  id: string,
): Promise<{ user: User; expired: boolean } | null> {
  const { rows } = await db.query<UserRow & { expired: boolean }>(
    `SELECT ${USER_COLUMNS}, s.expires_at <= now() AS expired
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? { user: toUser(row), expired: row.expired } : null;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [id]);
}

/** Deletes all of a user's sessions, except `keepId` if given. */
export async function deleteUserSessions(db: Db, userId: string, keepId?: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [
    userId,
    keepId ?? null,
  ]);
}
