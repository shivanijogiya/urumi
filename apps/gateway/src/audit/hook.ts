// The audit side of callTool's onCallFinished hook: one audit_log row per call, awaited so the row
// exists by the time the caller sees the result. A failed write never hides the tool result; the
// row's fields (no arguments, no results) go to the error log instead, so it is never silently lost.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { CallRecord } from '../core/call-tool.js';
import { insertAudit } from './repo.js';

export function createAuditWriter(
  pool: pg.Pool,
  log: FastifyBaseLogger,
): (record: CallRecord) => Promise<void> {
  return async (record) => {
    try {
      await insertAudit(pool, record);
    } catch (err) {
      log.error({ err: { message: (err as Error).message }, audit: record }, 'audit write failed');
    }
  };
}
