import { ConfigError, loadConfig } from './config.js';
import { createApp } from './server.js';
import { createWooClient } from './woo-client.js';

const SHUTDOWN_GRACE_MS = 10_000;

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  process.stderr.write(`${e instanceof ConfigError ? e.message : 'Invalid configuration'}\n`);
  process.exit(1);
}

const server = createApp(config, { client: createWooClient(config.woo) });
server.listen(config.port, () => {
  process.stdout.write(`${JSON.stringify({ msg: 'listening', port: config.port })}\n`);
});

function shutdown(signal: string) {
  process.stdout.write(`${JSON.stringify({ msg: 'shutting down', signal })}\n`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
