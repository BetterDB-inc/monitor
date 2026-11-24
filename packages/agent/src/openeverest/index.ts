import { loadOpenEverestConfig } from './config';
import { EverestClient } from './everest-client';
import { KubeClient } from './kube-client';
import { TargetManager } from './target-manager';
import { createPluginServer } from './plugin-server';

// Entry point of the OpenEverest mode (`--mode openeverest` or
// BETTERDB_AGENT_MODE=openeverest): the plugin backend plus one Agent per
// Valkey node of every enabled instance, all in this process.

const SHUTDOWN_DEADLINE_MS = 20_000;

export async function runOpenEverest(): Promise<void> {
  const log = (message: string) => console.log(`[OpenEverest] ${message}`);
  const config = loadOpenEverestConfig();
  const kube = KubeClient.inCluster();
  const everest = new EverestClient({ baseUrl: config.everestApiUrl });
  const manager = new TargetManager({ config, kube, everest, log });
  const server = createPluginServer({ backend: manager, uiDir: config.uiDir, log });

  log(`plugin "${config.pluginName}" in namespace ${kube.namespace}, OpenEverest API ${config.everestApiUrl}`);
  log(config.watchNamespaces.length > 0 ? `watching namespaces: ${config.watchNamespaces.join(', ')}` : 'watching all namespaces');

  await manager.start();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => resolve());
  });
  log(`listening on :${config.port}`);

  let stopping = false;
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
}
