import type { SimConfig } from '../config.js';
import { helm } from '../k8s.js';

// Install/upgrade a pinned chart straight from its repo URL (no `helm repo add`,
// so the user's global Helm repo config is untouched).
export async function helmUpgrade(
  cfg: SimConfig,
  release: string,
  chartKey: string,
  namespace: string,
  extra: string[] = [],
) {
  const c = cfg.charts[chartKey];
  if (!c) throw new Error(`charts.${chartKey} missing in sim.yaml`);
  await helm(cfg, [
    'upgrade', '--install', release, c.chart,
    '--repo', c.repo, '--version', c.version,
    '--namespace', namespace, '--create-namespace',
    '--wait', '--timeout', '10m',
    ...extra,
  ], { stdio: 'inherit' });
}
