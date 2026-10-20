import { z } from 'zod';

const nonEmpty = z.string({ error: 'is required' }).trim().min(1, { error: 'is required' });

// Custom messages only: zod's defaults are safe today, but error text must never echo env values.
const EnvSchema = z.object({
  PORT: z.coerce
    .number({ error: 'must be a port number' })
    .int({ error: 'must be a port number' })
    .min(0, { error: 'must be a port number' })
    .max(65535, { error: 'must be a port number' })
    .default(8080),
  WOO_MCP_SHARED_SECRET: z
    .string({ error: 'is required' })
    .min(32, { error: 'must be at least 32 characters' }),
  WOO_URL: nonEmpty.pipe(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })),
  WOO_USER: nonEmpty,
  WOO_APP_PASSWORD: nonEmpty,
  WOO_FORWARDED_PROTO: z.enum(['http', 'https'], { error: 'must be http or https' }).optional(),
  WOO_HOST_HEADER: nonEmpty.optional(),
});

export interface WooConfig {
  /** Base URL without trailing slash, e.g. `http://wordpress:80`. */
  url: string;
  user: string;
  appPassword: string;
  /** Sent as `X-Forwarded-Proto` so WordPress accepts Application Passwords over in-cluster HTTP. */
  forwardedProto?: 'http' | 'https';
  /** Host header override, for WordPress installs that redirect other hosts to WP_HOME. */
  hostHeader?: string;
}

export interface Config {
  port: number;
  sharedSecret: string;
  woo: WooConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses the environment. Throws a ConfigError that names bad variables but never their values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`);
    throw new ConfigError(`Invalid environment: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    sharedSecret: e.WOO_MCP_SHARED_SECRET,
    woo: {
      url: e.WOO_URL.replace(/\/+$/, ''),
      user: e.WOO_USER,
      appPassword: e.WOO_APP_PASSWORD,
      forwardedProto: e.WOO_FORWARDED_PROTO,
      hostHeader: e.WOO_HOST_HEADER,
    },
  };
}
