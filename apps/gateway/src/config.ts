// Environment config, validated once at startup. Errors name the variable, never its value.
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { z } from 'zod';

/** Optional string; an empty value counts as unset. */
const optional = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const EnvSchema = z.object({
  PORT: port(8080),
  DATABASE_URL: optional(),
  PGHOST: optional(),
  PGPORT: port(5432),
  PGUSER: optional(),
  PGPASSWORD: optional(),
  PGDATABASE: optional(),
  MIGRATIONS_DIR: optional(),
  SEED_ADMIN_EMAIL: z.email().transform((e) => e.toLowerCase()),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
  GATEWAY_ENC_KEY: z
    .string()
    .refine(
      (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32,
      'must be base64 of exactly 32 bytes',
    ),
  GATEWAY_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

/** Needed unless DATABASE_URL is set. Checked outside zod so they are reported with other errors. */
const PG_VARS = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;

export type DbConfig =
  | { connectionString: string }
  | { host: string; port: number; user: string; password: string; database: string };

export interface Config {
  port: number;
  db: DbConfig;
  migrationsDir: string;
  seedAdmin: { email: string; password: string };
  /** AES-256-GCM key for upstream credentials. */
  encKey: Buffer;
  sessionSecret: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  const isUnset = (name: string) => env[name] === undefined || env[name] === '';
  // Only the variable name and a fixed reason: zod issue messages never echo the input, and
  // `input` is deliberately not read here.
  const problems = (parsed.error?.issues ?? []).map((i) => {
    const name = String(i.path[0] ?? 'environment');
    return isUnset(name) ? `${name} is missing` : `${name} ${reason(i)}`;
  });
  if (isUnset('DATABASE_URL')) {
    for (const name of PG_VARS) {
      if (isUnset(name)) problems.push(`${name} is missing (or set DATABASE_URL)`);
    }
  }
  if (!parsed.success || problems.length) {
    throw new ConfigError(`Invalid configuration: ${[...new Set(problems)].join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    db: e.DATABASE_URL
      ? { connectionString: e.DATABASE_URL }
      : {
          host: e.PGHOST!,
          port: e.PGPORT,
          user: e.PGUSER!,
          password: e.PGPASSWORD!,
          database: e.PGDATABASE!,
        },
    migrationsDir: e.MIGRATIONS_DIR ?? MIGRATIONS_DIR,
    seedAdmin: { email: e.SEED_ADMIN_EMAIL, password: e.SEED_ADMIN_PASSWORD },
    encKey: Buffer.from(e.GATEWAY_ENC_KEY, 'base64'),
    sessionSecret: e.GATEWAY_SESSION_SECRET,
  };
}

function reason(issue: z.core.$ZodIssue): string {
  if (issue.code === 'custom' || issue.code === 'too_small') return issue.message;
  if (issue.code === 'invalid_format') return 'is not a valid ' + issue.format;
  return 'is invalid';
}
