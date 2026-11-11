import type { SimConfig } from '../config.js';
import { kubectl, kubectlJson } from '../k8s.js';
import { runHarnessJob } from './harness.js';

export interface PodInfo { name: string; ip: string; node: string; zone: string; shard: number; index: number; phase: string }

export async function valkeyPods(cfg: SimConfig): Promise<PodInfo[]> {
  const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', cfg.cluster.namespace, 'get', 'pods', '-l', `valkey.io/cluster=${cfg.cluster.name}`]);
  return pods.items.map((p) => ({
    name: p.metadata.name,
    ip: p.status.podIP,
    node: p.spec.nodeName,
    zone: p.metadata.labels['topology.kubernetes.io/zone'] ?? '',
    shard: Number(p.metadata.labels['valkey.io/shard-index']),
    index: Number(p.metadata.labels['valkey.io/node-index']),
    phase: p.status.phase,
  }));
}

// valkey-cli inside a server container. The pod env sets VALKEYCLI_AUTH for a user the
// default-user CLI doesn't use, which only produces AUTH warnings — unset it.
export async function valkeyCli(cfg: SimConfig, pod: string, args: string[]) {
  const { stdout } = await kubectl(cfg, ['-n', cfg.cluster.namespace, 'exec', pod, '-c', 'server', '--', 'env', '-u', 'VALKEYCLI_AUTH', 'valkey-cli', ...args]);
  return String(stdout);
}

const parseInfo = (s: string) => Object.fromEntries(s.split(/\r?\n/).filter((l) => l.includes(':')).map((l) => l.split(':', 2) as [string, string]));

// CLUSTER NODES → ip → role/primaryId (text format is stable across versions).
export async function clusterRoles(cfg: SimConfig, pod: string) {
  const out = await valkeyCli(cfg, pod, ['cluster', 'nodes']);
  return out.trim().split('\n').map((l) => {
    const [id, addr, flags, primaryId] = l.split(' ');
    return { id: id!, ip: addr!.split(':')[0]!, role: flags!.includes('master') ? 'primary' : 'replica', primaryId: primaryId === '-' ? null : primaryId!, flags: flags! };
  });
}

export async function verifyCluster(cfg: SimConfig) {
  const c = cfg.cluster;
  const expectedPods = c.shards * (1 + c.replicasPerShard);
  const checks: [string, boolean, string][] = [];

  const vc = await kubectlJson(cfg, ['-n', c.namespace, 'get', 'valkeycluster', c.name]);
  const ready = (vc.status?.conditions ?? []).find((x: any) => x.type === 'Ready');
  checks.push(['ValkeyCluster Ready', ready?.status === 'True', `${vc.status?.state} readyShards=${vc.status?.readyShards}`]);

  const pods = await valkeyPods(cfg);
  const running = pods.filter((p) => p.phase === 'Running').length;
  checks.push([`${expectedPods} pods Running`, running === expectedPods, `${running}/${pods.length}`]);

  const vns = await kubectlJson<{ items: any[] }>(cfg, ['-n', c.namespace, 'get', 'valkeynodes']);
  const vnRoles = vns.items.reduce((a: Record<string, number>, n) => ((a[n.status?.role] = (a[n.status?.role] ?? 0) + 1), a), {});
  checks.push([`ValkeyNodes ${c.shards} primary / ${c.shards * c.replicasPerShard} replica`, vnRoles.primary === c.shards && vnRoles.replica === c.shards * c.replicasPerShard, JSON.stringify(vnRoles)]);

  const probe = pods.find((p) => p.phase === 'Running')!.name;
  const info = parseInfo(await valkeyCli(cfg, probe, ['cluster', 'info']));
  checks.push(['cluster_state:ok', info.cluster_state === 'ok', info.cluster_state ?? '?']);
  checks.push(['16384 slots ok', info.cluster_slots_ok === '16384', info.cluster_slots_ok ?? '?']);
  checks.push([`cluster_known_nodes ${expectedPods}`, Number(info.cluster_known_nodes) === expectedPods, info.cluster_known_nodes ?? '?']);

  // Placement table from Valkey's own view of roles (ValkeyNode role is only the initial index).
  const roles = await clusterRoles(cfg, probe);
  const byIp = new Map(pods.map((p) => [p.ip, p]));
  const groups = new Map<string, { primary?: PodInfo; replicas: PodInfo[] }>();
  for (const r of roles) {
    const key = r.role === 'primary' ? r.id : r.primaryId!;
    const g = groups.get(key) ?? { replicas: [] };
    const pod = byIp.get(r.ip);
    if (pod) r.role === 'primary' ? (g.primary = pod) : g.replicas.push(pod);
    groups.set(key, g);
  }
  const rows = [...groups.values()].filter((g) => g.primary).sort((a, b) => a.primary!.shard - b.primary!.shard);
  let spreadOk = rows.length === c.shards;
  console.log('\nshard | primary (worker/zone)               | replicas (worker/zone)');
  for (const g of rows) {
    const all = [g.primary!, ...g.replicas];
    const distinct = new Set(all.map((p) => p.node)).size === all.length && g.replicas.length === c.replicasPerShard;
    spreadOk &&= distinct;
    const fmt = (p: PodInfo) => `${p.name}@${p.node.replace(`${cfg.kind.clusterName}-`, '')}/${p.zone}`;
    console.log(`${String(g.primary!.shard).padStart(5)} | ${fmt(g.primary!).padEnd(36)} | ${g.replicas.map(fmt).join(', ')}${distinct ? '' : '  ← NOT DISTINCT'}`);
  }
  checks.push(['each shard on distinct workers', spreadOk, `${rows.length} shards`]);

  const smoke = await runHarnessJob(cfg, 'smoke', ['smoke']);
  const m = smoke.match(/\{"smoke":.*\}/);
  const res = m ? JSON.parse(m[0]).smoke : null;
  checks.push(['GLIDE SET/GET all 16384 slots', res?.mismatches === 0 && res?.slots === 16384, m?.[0] ?? smoke.slice(-300)]);

  console.log('\ncheck                                      | ok | detail');
  for (const [name, ok, detail] of checks) console.log(`${name.padEnd(42)} | ${ok ? '✔ ' : '✘ '} | ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}
