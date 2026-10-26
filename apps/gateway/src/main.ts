// Gateway entry point: config -> wait for Postgres -> migrate -> seed admin -> listen -> health loop.
import { createAnthropicClient } from './chat/anthropic.js';
import { ConfigError, loadConfig } from './config.js';
import { HealthMonitor } from './core/health.js';
import { HEALTH_LEASE, Lease } from './core/leader.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { seedAdmin } from './db/seed.js';
import { GatewayMetrics } from './metrics/metrics.js';
import { startMetricsServer } from './metrics/server.js';
import { HttpKubeApi } from './hosted/kube.js';
import { HOSTED_LEASE } from './hosted/reconciler.js';
import { HttpStoreKubeApi } from './stores/kube.js';
import { loadBootstrapScripts, STORES_LEASE } from './stores/provisioner.js';
import { buildApp, LOGGER_OPTIONS } from './server.js';

const DB_WAIT_MS = 120_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Same JSON shape as the app logs; the message names variables, never values.
      console.error(JSON.stringify({ level: 60, time: Date.now(), msg: err.message }));
      process.exit(1);
    }
    throw err;
  }

  // Multiple stores (ADR 015): the bootstrap scripts come from the chart's ConfigMap mount.
  const storeScripts = config.multiStore
    ? await loadBootstrapScripts(config.multiStore.scriptsDir)
    : null;

  // The pool only logs after startup, by which time `server` exists.
  const pool = createPool(config.db, { error: (obj, msg) => server.log.error(obj, msg) });
  const metrics = new GatewayMetrics({ pool });
  const server = buildApp({
    pool,
    logger: LOGGER_OPTIONS,
    publicOrigin: config.publicOrigin,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    encKey: config.encKey,
    upstreamAllowedHosts: config.upstreamAllowedHosts,
    chat: {
      anthropic: config.anthropicApiKey ? createAnthropicClient(config.anthropicApiKey) : null,
      model: config.chatModel,
      discoveryThreshold: config.chatDiscoveryThreshold,
    },
    track: config.track,
    faultInject: config.faultInject,
    mcpRateLimits: config.mcpRateLimits,
    metrics,
    oauth: { redirectSchemes: config.oauthRedirectSchemes },
    ...(config.hosted
      ? {
          hosted: {
            kube: new HttpKubeApi({
              namespace: config.hosted.namespace,
              host: config.hosted.kubeHost,
              port: config.hosted.kubePort,
            }),
            namespace: config.hosted.namespace,
            serviceAccountName: config.hosted.serviceAccountName,
            allowedImages: config.hosted.allowedImages,
            requireDigest: config.hosted.requireDigest,
            maxServers: config.hosted.maxServers,
            lease: new Lease(pool, HOSTED_LEASE, config.podName),
          },
        }
      : {}),
    ...(config.multiStore && storeScripts
      ? {
          stores: {
            kube: new HttpStoreKubeApi({
              host: config.multiStore.kubeHost,
              port: config.multiStore.kubePort,
            }),
            settings: config.multiStore.settings,
            maxStores: config.multiStore.maxStores,
            scripts: storeScripts,
            lease: new Lease(pool, STORES_LEASE, config.podName),
          },
        }
      : {}),
    builtInStore: config.builtInStore,
  });
  if (!config.anthropicApiKey) server.log.warn('ANTHROPIC_API_KEY is not set: chat is disabled');
  if (config.faultInject.errorRate > 0 || config.faultInject.latencyMs > 0) {
    server.log.warn({ track: config.track, ...config.faultInject }, 'FAULT INJECTION is on');
  }

  // Several replicas (ADR 010): only the holder of the `health` lease runs the 15 s loop.
  const health = new HealthMonitor({
    pool,
    registry: server.tools.registry,
    log: server.log,
    lease: new Lease(pool, HEALTH_LEASE, config.podName),
  });

  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'shutting down');
    await health.stop().catch(() => undefined);
    await server.hostedReconciler?.stop().catch(() => undefined);
    await server.storeProvisioner?.stop().catch(() => undefined);
    await metricsServer?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await waitForDatabase(pool, server.log);
  await migrate(pool, config.migrationsDir, server.log);
  await seedAdmin(pool, config.seedAdmin, server.log);
  await server.listen({ host: '0.0.0.0', port: config.port });
  if (config.metricsPort > 0) {
    metricsServer = await startMetricsServer(metrics, {
      port: config.metricsPort,
      log: server.log,
    });
    server.log.info({ port: config.metricsPort }, 'metrics listening (internal)');
  }
  health.start();
  if (server.hostedReconciler) {
    server.hostedReconciler.start();
    server.log.info({ namespace: config.hosted?.namespace }, 'hosted MCP servers enabled');
  }
  if (server.storeProvisioner) {
    server.storeProvisioner.start();
    server.log.info({ maxStores: config.multiStore?.maxStores }, 'multiple stores enabled');
  }
}

async function waitForDatabase(
  pool: ReturnType<typeof createPool>,
  log: { warn(obj: object, msg: string): void },
): Promise<void> {
  const deadline = Date.now() + DB_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error('Postgres not reachable', { cause: err });
      log.warn({ attempt, err: { message: (err as Error).message } }, 'waiting for Postgres');
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
}

main().catch((err: Error) => {
  console.error(
    JSON.stringify({ level: 60, time: Date.now(), msg: 'startup failed', err: err.message }),
  );
  process.exit(1);
});
