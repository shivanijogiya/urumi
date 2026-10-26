// Real Postgres for the integration tests (nothing under test is mocked).
// Default: starts postgres:16-alpine with docker on a random localhost port and removes it after.
// TEST_DATABASE_URL: use an existing server instead (e.g. a CI service). Its user must be able to
// CREATE DATABASE, because every test gets its own database (see test/helpers/db.ts).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

async function waitForPostgres(url: string, deadlineMs: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadlineMs) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('select 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(`Postgres did not become ready: ${String(lastError)}`);
}

export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    await waitForPostgres(external, Date.now() + 30_000);
    project.provide('pgAdminUrl', external);
    return;
  }

  // Throwaway password for a container that only listens on 127.0.0.1 and is removed afterwards.
  const password = randomBytes(12).toString('hex');
  const { stdout } = await run('docker', [
    'run',
    '-d',
    '--rm',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-p',
    '127.0.0.1::5432',
    'postgres:16-alpine',
    // Throwaway server: no durability needed, and a small WAL keeps the data volume small.
    '-c',
    'fsync=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'max_wal_size=96MB',
    '-c',
    'min_wal_size=32MB',
  ]);
  const containerId = stdout.trim();
  // -v: also delete the container's anonymous data volume. `--rm` alone does not when the
  // container is removed with `docker rm -f`, and every run would leak its test databases (GBs).
  const stop = () => run('docker', ['rm', '-f', '-v', containerId]).then(() => undefined);

  try {
    const port = (await run('docker', ['port', containerId, '5432/tcp'])).stdout
      .trim()
      .split('\n')[0]!
      .split(':')
      .pop();
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    // The image restarts the server once after initdb; wait for a real query to succeed.
    await waitForPostgres(url, Date.now() + 60_000);
    project.provide('pgAdminUrl', url);
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
}
