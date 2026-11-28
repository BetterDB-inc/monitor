import { loadOpenEverestConfig } from './config';
import { EverestClient } from './everest-client';
import { KubeClient, sleep } from './kube-client';
import { TargetManager } from './target-manager';
import { createPluginServer } from './plugin-server';

// Entry point of the OpenEverest mode (`--mode openeverest` or
// BETTERDB_AGENT_MODE=openeverest): the plugin backend plus one Agent per
// Valkey node of every enabled instance, all in this process.

const SHUTDOWN_DEADLINE_MS = 20_000;
const START_RETRY_MAX_MS = 30_000;

export async function runOpenEverest(): Promise<void> {
  const log = (message: string) => console.log(`[OpenEverest] ${message}`);
  const config = loadOpenEverestConfig();
  const kube = KubeClient.inCluster();
  const everest = new EverestClient({ baseUrl: config.everestApiUrl });
  const manager = new TargetManager({ config, kube, everest, log });
  let ready = false;
  let stopping = false;
  const server = createPluginServer({ backend: manager, uiDir: config.uiDir, log, ready: () => ready });

  log(`plugin "${config.pluginName}" in namespace ${kube.namespace}, OpenEverest API ${config.everestApiUrl}`);
  log(config.watchNamespaces.length > 0 ? `watching namespaces: ${config.watchNamespaces.join(', ')}` : 'watching all namespaces');

  // Listen first: the liveness probe only needs the process up, and the
  // manager's start may take a while (retrying the cluster id, a slow API
  // server). Readiness turns on when the manager is running.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => resolve());
  });
  log(`listening on :${config.port}`);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('shutting down');
    // Kubernetes gives terminationGracePeriodSeconds (30s by default) before
    // SIGKILL; leave before that even if a connection refuses to close.
    const deadline = setTimeout(() => {
      log('shutdown deadline reached, exiting');
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    server.close();
    await manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A failed start (API server unreachable, ConfigMap unreadable) is retried
  // with backoff rather than exiting: a restart loop would not help, and the
  // probes already say the pod is alive but not ready.
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await manager.start();
      ready = true;
      log('ready');
      return;
    } catch (err) {
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), START_RETRY_MAX_MS);
      log(`start failed (${(err as Error).message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
