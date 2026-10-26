// Image allow-list for hosted MCP servers (ADR 014). An image reference is normalised the way the
// container runtime resolves it (a first path component without '.', ':' or 'localhost' is a
// Docker Hub repository: `mcp/x` -> `docker.io/mcp/x`, `alpine` -> `docker.io/library/alpine`), then
// must start with one of HOSTED_ALLOWED_IMAGES. Every allow-list entry ends with '/', so
// `docker.io/mcp/` never matches `docker.io/mcpevil/x` and `registry:5005/` never matches
// `registry:5005.evil.com/x`. An `@sha256:` digest pins the exact image and is recorded.
import { IMAGE_REF_RE } from '@urumi/contracts';
import { HttpError } from '../http/errors.js';

export interface ParsedImage {
  /** Normalised reference as given (tag kept, digest removed). */
  name: string;
  /** `sha256:<64 hex>` or null. */
  digest: string | null;
  /** What the pod runs: `name@digest` when pinned, else `name`. */
  ref: string;
}

export class ImageNotAllowedError extends HttpError {
  override name = 'ImageNotAllowedError';
  constructor(message: string) {
    super('VALIDATION_FAILED', message);
  }
}

/** Normalises a reference that matched IMAGE_REF_RE. */
export function parseImageRef(raw: string): ParsedImage {
  if (!IMAGE_REF_RE.test(raw)) throw new ImageNotAllowedError('Invalid image reference');
  const at = raw.indexOf('@');
  const digest = at >= 0 ? raw.slice(at + 1) : null;
  let name = at >= 0 ? raw.slice(0, at) : raw;
  const first = name.split('/')[0]!;
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (!hasRegistry) {
    name = name.includes('/') ? `docker.io/${name}` : `docker.io/library/${name}`;
  }
  return { name, digest, ref: digest ? `${name}@${digest}` : name };
}

/** Allow-list entries: lowercase, end with '/', at least `registry/`. */
export function normaliseAllowList(entries: readonly string[]): string[] {
  return entries
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.endsWith('/') ? e : `${e}/`));
}

/**
 * Throws ImageNotAllowedError (400) unless `raw` is a valid reference under an allowed prefix (and
 * pinned by digest when `requireDigest`). The message names the rule, never other entries.
 */
export function checkImage(
  raw: string,
  opts: { allow: readonly string[]; requireDigest: boolean },
): ParsedImage {
  const parsed = parseImageRef(raw);
  if (
    !opts.allow.some(
      (prefix) => parsed.name.startsWith(prefix) && parsed.name.length > prefix.length,
    )
  ) {
    throw new ImageNotAllowedError(
      'Image is not allowed: its registry/repository is not on the hosted image allow-list',
    );
  }
  if (opts.requireDigest && !parsed.digest) {
    throw new ImageNotAllowedError('Image must be pinned by digest (@sha256:...)');
  }
  return parsed;
}
