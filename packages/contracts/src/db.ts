// Node-only entry point: `@urumi/contracts/db`. Kept out of the root index so the browser bundle stays clean.
import { fileURLToPath } from 'node:url';

/** Directory of numbered `NNN_name.sql` migrations, applied in order by the gateway's runner. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../sql/', import.meta.url));

export type * from './rows.js';
