import { execa, type Options } from 'execa';
import type { SimConfig } from './config.js';

// Every kubectl/helm call is pinned to the kind context. The user's current
// context is never read or switched.
export const kubeContext = (cfg: SimConfig) => `kind-${cfg.kind.clusterName}`;

export function kubectl(cfg: SimConfig, args: string[], opts: Options = {}) {
  return execa('kubectl', ['--context', kubeContext(cfg), ...args], { ...opts });
}

export function helm(cfg: SimConfig, args: string[], opts: Options = {}) {
  return execa('helm', ['--kube-context', kubeContext(cfg), ...args], { ...opts });
}

export async function kubectlJson<T = any>(cfg: SimConfig, args: string[]): Promise<T> {
  const { stdout } = await kubectl(cfg, [...args, '-o', 'json']);
  return JSON.parse(String(stdout)) as T;
}

export async function kubectlApply(cfg: SimConfig, manifest: string, extra: string[] = []) {
  return kubectl(cfg, ['apply', '-f', '-', ...extra], { input: manifest });
}

export async function kindClusterExists(name: string): Promise<boolean> {
  const { stdout } = await execa('kind', ['get', 'clusters']);
  return String(stdout).split('\n').includes(name);
}
