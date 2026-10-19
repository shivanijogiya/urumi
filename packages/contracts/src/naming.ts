/** Upstream slug: 1–20 chars of `[a-z0-9-]`, no leading/trailing hyphen. `_` is excluded, so a slug never contains `__`. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
export const SEPARATOR = '__';
/** Claude tool names must match `^[a-zA-Z0-9_-]{1,64}$`. */
export const MAX_QUALIFIED_LEN = 64;

const HASH_LEN = 8;

/** FNV-1a 32-bit over the UTF-8 bytes, as 8 hex chars. Not cryptographic; pure TS so it runs in the browser. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(HASH_LEN, '0');
}

/**
 * Builds the gateway-facing name `{slug}__{tool}`. Characters outside `[a-zA-Z0-9_-]` become `_`;
 * if the result exceeds 64 chars the tool part is truncated and suffixed with `_` + 8 hex chars of
 * fnv1a32(original tool) so it stays unique. Pure and deterministic.
 *
 * Sanitization is lossy: the gateway keeps a map qualified → original upstream tool name and
 * routes through it. Routing never reverses sanitization.
 */
export function qualifyToolName(slug: string, tool: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid server slug: ${JSON.stringify(slug)}`);
  const prefix = slug + SEPARATOR;
  const toolPart = tool.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (prefix.length + toolPart.length <= MAX_QUALIFIED_LEN) return prefix + toolPart;
  const keep = MAX_QUALIFIED_LEN - prefix.length - HASH_LEN - 1;
  return `${prefix}${toolPart.slice(0, keep)}_${fnv1a32(tool)}`;
}

/** Splits on the first `__` (slugs cannot contain `_`). Returns null if the name is not qualified. */
export function parseQualifiedName(name: string): { slug: string; toolPart: string } | null {
  const i = name.indexOf(SEPARATOR);
  if (i < 0) return null;
  const slug = name.slice(0, i);
  const toolPart = name.slice(i + SEPARATOR.length);
  return SLUG_RE.test(slug) && toolPart.length > 0 ? { slug, toolPart } : null;
}
