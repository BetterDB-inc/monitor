import { writeFileSync } from 'node:fs';
import { execa } from 'execa';
import { stringify } from 'yaml';
import type { SimConfig } from '../config.js';
import { kindClusterExists, kubectl, kubectlJson } from '../k8s.js';

const ZONE_LABEL = 'topology.kubernetes.io/zone';
const zoneName = (i: number) => `zone-${String.fromCharCode(97 + i)}`;

export function renderKindConfig(cfg: SimConfig) {
  const workers = Array.from({ length: cfg.kind.workers }, () => ({ role: 'worker', image: cfg.kind.nodeImage }));
  return stringify({
    kind: 'Cluster',
    apiVersion: 'kind.x-k8s.io/v1alpha4',
    name: cfg.kind.clusterName,
    nodes: [
      {
        role: 'control-plane',
        image: cfg.kind.nodeImage,
        extraPortMappings: [{ containerPort: cfg.betterdb.nodePort, hostPort: Number(new URL(cfg.betterdb.url).port), listenAddress: '127.0.0.1' }],
      },
      ...workers,
    ],
  });
}

export async function kindUp(cfg: SimConfig, configPath: string) {
  writeFileSync(configPath, renderKindConfig(cfg));
  if (await kindClusterExists(cfg.kind.clusterName)) {
    console.log(`kind cluster ${cfg.kind.clusterName} exists, reusing`);
  } else {
    await execa('kind', ['create', 'cluster', '--config', configPath, '--wait', '300s'], { stdio: 'inherit' });
  }
  const nodes = await kubectlJson<{ items: any[] }>(cfg, ['get', 'nodes', '-l', '!node-role.kubernetes.io/control-plane']);
  const names = nodes.items.map((n) => n.metadata.name as string).sort();
  for (const [i, name] of names.entries()) {
    await kubectl(cfg, ['label', 'node', name, `${ZONE_LABEL}=${zoneName(i % cfg.kind.zones)}`, '--overwrite']);
  }
}
