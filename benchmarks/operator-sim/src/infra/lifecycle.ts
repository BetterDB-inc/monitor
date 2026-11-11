import { execa } from 'execa';
import type { SimConfig } from '../config.js';
import { deleteHarnessJob, runHarnessJob } from './harness.js';
import { kindClusterExists, kubectl, kubectlJson } from '../k8s.js';
import { loadDown } from '../load/memtier.js';
import { truthStop } from '../truth/deploy.js';
import { renderValkeyCluster, waitClusterReady } from './valkey.js';
import { valkeyCli, valkeyPods, clusterRoles } from './verify.js';

const INJECTORS = ['hotShard', 'slowPreload', 'slowCommands', 'memoryPressure', 'replicaLag'].map((p) => `inj-${p.toLowerCase()}`);

async function deleteChaos(cfg: SimConfig) {
  for (const kind of ['networkchaos', 'podchaos'])
    await kubectl(cfg, ['-n', cfg.cluster.namespace, 'delete', kind, '-l', 'app=operator-sim', '--ignore-not-found', '--wait'], { reject: false });
}

// Back to the take-1 baseline without recreating kind: chaos gone, injectors gone,
// image + config re-applied from sim.yaml (a roll if the image changed), data flushed
// and re-warmed so every take starts from the same dataset.
export async function reset(cfg: SimConfig) {
  await deleteChaos(cfg);
  for (const j of INJECTORS) await deleteHarnessJob(cfg, j);
  await loadDown(cfg);
  await truthStop(cfg);
  const vc = await kubectlJson(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeycluster', cfg.cluster.name]);
  if (vc.spec.image !== cfg.cluster.valkeyImage) console.log(`rolling ${vc.spec.image} → ${cfg.cluster.valkeyImage} (operator roll, ~8 min)`);
  await kubectl(cfg, ['apply', '--server-side', '--field-manager', 'operator-sim', '--force-conflicts', '-f', '-'], { input: renderValkeyCluster(cfg) });
  // The operator may still be reporting Ready from before the patch; let it observe the change.
  await new Promise((r) => setTimeout(r, cfg.cluster.pollSec * 2000));
  await waitClusterReady(cfg, cfg.scenario.rollingUpdate.timeoutSec);
  // Phase leftovers (maxmemory, flooded/big keys) are cleared on every primary.
  const pods = await valkeyPods(cfg);
  const roles = await clusterRoles(cfg, pods[0]!.name);
  for (const p of pods.filter((x) => roles.find((r) => r.ip === x.ip)?.role === 'primary')) {
    await valkeyCli(cfg, p.name, ['config', 'set', 'maxmemory', cfg.cluster.maxmemory]);
    await valkeyCli(cfg, p.name, ['flushall', 'sync']);
  }
  console.log((await runHarnessJob(cfg, 'warm', ['warm'])).split('\n').filter((l) => !/"done":\d/.test(l)).join('\n'));
}

// KEEP_CLUSTER=1 → remove our workloads/releases only; otherwise delete the kind
// cluster this repo created (by exact name). runs/ is never touched.
export async function down(cfg: SimConfig, keepCluster: boolean) {
  if (!(await kindClusterExists(cfg.kind.clusterName))) return console.log(`kind cluster ${cfg.kind.clusterName} not found; nothing to do`);
  if (!keepCluster) {
    await execa('kind', ['delete', 'cluster', '--name', cfg.kind.clusterName], { stdio: 'inherit' });
    return;
  }
  await kubectl(cfg, ['delete', 'ns', cfg.harness.namespace, '--ignore-not-found', '--wait'], { reject: false });
  await deleteChaos(cfg);
  await kubectl(cfg, ['-n', cfg.cluster.namespace, 'delete', 'valkeycluster', cfg.cluster.name, '--ignore-not-found', '--wait'], { reject: false });
  for (const [release, ns] of [[cfg.betterdb.release, cfg.betterdb.namespace], ['chaos-mesh', cfg.chaos.namespace], ['valkey-operator', cfg.operator.namespace]] as const)
    await execa('helm', ['--kube-context', `kind-${cfg.kind.clusterName}`, 'uninstall', release, '-n', ns, '--ignore-not-found', '--wait'], { stdio: 'inherit', reject: false });
  for (const ns of [cfg.betterdb.namespace, cfg.chaos.namespace, cfg.operator.namespace, cfg.cluster.namespace])
    await kubectl(cfg, ['delete', 'ns', ns, '--ignore-not-found', '--wait'], { reject: false });
}
