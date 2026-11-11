import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { SimConfig } from '../config.js';
import { helm, kubectl, kubectlApply, kubectlJson } from '../k8s.js';
import { ensureMonitorUserSecret } from './betterdb.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const CHART_CACHE = join(ROOT, '.bin', 'charts');

export function renderTemplate(tmpl: string, vars: Record<string, string | number>) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template var {{${k}}} has no value`);
    return String(vars[k]);
  });
}

export function renderValkeyCluster(cfg: SimConfig, image = cfg.cluster.valkeyImage) {
  const c = cfg.cluster;
  return renderTemplate(readFileSync(join(ROOT, 'infra/valkey/valkeycluster.yaml.tmpl'), 'utf8'), {
    name: c.name,
    namespace: c.namespace,
    shards: c.shards,
    replicas: c.replicasPerShard,
    image,
    cpu: c.resources.cpu,
    memoryRequest: c.resources.memoryRequest,
    memoryLimit: c.resources.memoryLimit,
    exporterCpu: c.exporterResources.cpu,
    exporterMemory: c.exporterResources.memory,
    maxmemory: c.maxmemory,
    maxmemoryPolicy: c.maxmemoryPolicy,
    slowlogSlowerThanUs: c.slowlogSlowerThanUs,
    latencyMonitorThresholdMs: c.latencyMonitorThresholdMs,
    enableDebugCommand: c.enableDebugCommand,
    usersSecret: c.usersSecret,
    monitorUser: cfg.betterdb.valkeyUser,
    monitorAcl: cfg.betterdb.valkeyAcl,
  });
}

async function pulledChartDir(cfg: SimConfig, key: string) {
  const c = cfg.charts[key]!;
  const dir = join(CHART_CACHE, `${c.chart}-${c.version}`);
  try {
    readdirSync(join(dir, c.chart));
  } catch {
    mkdirSync(dir, { recursive: true });
    await execa('helm', ['pull', c.chart, '--repo', c.repo, '--version', c.version, '--untar', '-d', dir]);
  }
  return join(dir, c.chart);
}

export async function operatorUp(cfg: SimConfig) {
  const chartDir = await pulledChartDir(cfg, 'valkeyOperator');
  // Server-side apply so CRD upgrades don't hit the client-side annotation size limit.
  await kubectl(cfg, ['apply', '--server-side', '--force-conflicts', '-f', join(chartDir, 'crds')], { stdio: 'inherit' });
  await helm(cfg, [
    'upgrade', '--install', 'valkey-operator', chartDir,
    '--namespace', cfg.operator.namespace, '--create-namespace', '--skip-crds',
    '-f', join(ROOT, 'infra/operator/values.yaml'), '--wait', '--timeout', '5m',
  ], { stdio: 'inherit' });
}

export async function clusterUp(cfg: SimConfig) {
  await ensureMonitorUserSecret(cfg);
  // Never re-apply an image over a cluster that is already on another one: that is
  // the rollingUpdate phase's job, and `make reset` restores the baseline.
  const existing = await kubectl(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeycluster', cfg.cluster.name, '-o', 'jsonpath={.spec.image}'], { reject: false });
  const image = existing.exitCode === 0 && existing.stdout ? String(existing.stdout) : cfg.cluster.valkeyImage;
  await kubectlApply(cfg, renderValkeyCluster(cfg, image), ['--server-side', '--field-manager', 'operator-sim']);
  await waitClusterReady(cfg, cfg.cluster.readyTimeoutSec);
  await waitNodesCondition(cfg, 'ACLApplied', cfg.cluster.readyTimeoutSec);
}

// ACL edits are live-applied per node once kubelet syncs the Secret volume (~1 min),
// so the cluster reports Ready before every node has the new users.
export async function waitNodesCondition(cfg: SimConfig, type: string, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = -1;
  for (;;) {
    const vns = await kubectlJson<{ items: any[] }>(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeynodes', '-l', `valkey.io/cluster=${cfg.cluster.name}`]);
    const ok = vns.items.filter((n) => (n.status?.conditions ?? []).some((c: any) => c.type === type && c.status === 'True')).length;
    if (ok !== last) console.log(`  ${new Date().toISOString()} ${type}: ${ok}/${vns.items.length}`), (last = ok);
    if (vns.items.length > 0 && ok === vns.items.length) return;
    if (Date.now() > deadline) throw new Error(`${type} on ${ok}/${vns.items.length} ValkeyNodes after ${timeoutSec}s`);
    await new Promise((r) => setTimeout(r, cfg.cluster.pollSec * 1000));
  }
}

export async function waitClusterReady(cfg: SimConfig, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  for (;;) {
    const vc = await kubectlJson(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeycluster', cfg.cluster.name]);
    const s = vc.status ?? {};
    const line = `state=${s.state} reason=${s.reason ?? ''} readyShards=${s.readyShards ?? 0}/${cfg.cluster.shards}`;
    if (line !== last) console.log(`  ${new Date().toISOString()} ${line}`), (last = line);
    const ready = (s.conditions ?? []).find((c: any) => c.type === 'Ready');
    if (ready?.status === 'True' && s.readyShards === cfg.cluster.shards) return vc;
    if (Date.now() > deadline) throw new Error(`ValkeyCluster not Ready after ${timeoutSec}s: ${line}`);
    await new Promise((r) => setTimeout(r, cfg.cluster.pollSec * 1000));
  }
}
