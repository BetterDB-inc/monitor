// Per-node ground truth, independent of BetterDB. One connection per node, no KEYS/SCAN.
// Runs in-cluster; pod → shard comes from the operator's pod labels via the K8s API.
// Output: JSONL {ts, pod, shard, role, metric, value} appended to TRUTH_FILE.
import { createWriteStream, readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import type { SimConfig } from '../config.js';
import { RespClient } from '../resp.js';
import { VALKEY_PORT } from '../valkey.js';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

interface Pod { name: string; ip: string; shard: number }
interface Node { pod: Pod; client: RespClient; role: string; lastSlowlogId: number; lastCommandlogId: number; nextAt: number; latencySeen: Map<string, number>; lastViewAt: number }

function listPods(cfg: SimConfig): Promise<Pod[]> {
  const token = readFileSync(`${SA}/token`, 'utf8');
  const agent = new Agent({ ca: readFileSync(`${SA}/ca.crt`) });
  const path = `/api/v1/namespaces/${cfg.cluster.namespace}/pods?labelSelector=${encodeURIComponent(`valkey.io/cluster=${cfg.cluster.name}`)}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: 'kubernetes.default.svc', path, agent, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`pods ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(JSON.parse(body).items
          .filter((p: any) => p.status.podIP && p.status.phase === 'Running' && !p.metadata.deletionTimestamp)
          .map((p: any) => ({ name: p.metadata.name, ip: p.status.podIP, shard: Number(p.metadata.labels['valkey.io/shard-index']) })));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const parseInfo = (s: string) => Object.fromEntries(s.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes(':')).map((l) => {
  const i = l.indexOf(':');
  return [l.slice(0, i), l.slice(i + 1)];
}));

export async function truthCollector(cfg: SimConfig) {
  const t = cfg.truth;
  const out = createWriteStream(process.env.TRUTH_FILE ?? t.file, { flags: 'a' });
  const emit = (pod: Pod, role: string, metric: string, value: unknown, ts = Date.now()) =>
    out.write(JSON.stringify({ ts, pod: pod.name, shard: pod.shard, role, metric, value }) + '\n');
  const nodes = new Map<string, Node>();
  const startedAt = Date.now();
  let lastShards = 0;
  let lastSlotStats = 0;

  async function refreshPods() {
    const pods = await listPods(cfg);
    const live = new Set(pods.map((p) => `${p.name}@${p.ip}`));
    // Drop pods that are gone and connections that died (reopened below).
    for (const [k, n] of nodes) if (!live.has(k) || n.client.isClosed) (n.client.close(), nodes.delete(k));
    for (const p of pods) {
      const k = `${p.name}@${p.ip}`;
      if (nodes.has(k)) continue;
      try {
        const client = await RespClient.open(p.ip, VALKEY_PORT, t.requestTimeoutMs, t.clientName);
        nodes.set(k, { pod: p, client, role: 'unknown', lastSlowlogId: -1, lastCommandlogId: -1, nextAt: 0, latencySeen: new Map(), lastViewAt: 0 });
      } catch (e) {
        emit(p, 'unknown', 'collector_error', String(e).slice(0, 200));
      }
    }
  }

  async function sampleNode(n: Node, now: number) {
    const info = parseInfo(String(await n.client.call(['INFO', 'stats', 'memory', 'replication', 'clients', 'cpu'])));
    const role = info.role === 'master' ? 'primary' : 'replica';
    if (role !== n.role && n.role !== 'unknown') emit(n.pod, role, 'role_change', { from: n.role, to: role }, now);
    n.role = role;
    for (const f of t.infoFields) if (f in info) emit(n.pod, role, f, Number.isFinite(Number(info[f])) ? Number(info[f]) : info[f], now);
    const ci = parseInfo(String(await n.client.call(['CLUSTER', 'INFO'])));
    emit(n.pod, role, 'cluster_state', ci.cluster_state, now);
    // This node's view of the topology: primaries with slots vs. `master` entries that own
    // none (a demoted node not yet re-gossiped). Exposes view divergence after failovers.
    if (now - n.lastViewAt >= t.viewIntervalSec * 1000) {
      n.lastViewAt = now;
      const rows = String(await n.client.call(['CLUSTER', 'NODES'])).trim().split('\n').map((l) => l.split(' '));
      const masters = rows.filter((r) => r[2]!.includes('master') && !r[2]!.includes('fail'));
      const slotless = masters.filter((r) => r.slice(8).length === 0).map((r) => r[1]!.split(':')[0]!);
      emit(n.pod, role, 'cluster_view', { primariesWithSlots: masters.length - slotless.length, slotlessPrimaries: slotless, failFlags: rows.filter((r) => r[2]!.includes('fail')).length }, now);
    }
    if (role !== 'primary') return;

    const lat = (await n.client.call(['LATENCY', 'LATEST'])) as any[];
    // LATENCY LATEST repeats the last spike forever; emit an event only when its ts moves.
    for (const [event, ts, latest, max] of lat ?? []) {
      if (n.latencySeen.get(String(event)) === Number(ts)) continue;
      n.latencySeen.set(String(event), Number(ts));
      if (Number(ts) * 1000 >= startedAt) emit(n.pod, role, 'latency_latest', { event: String(event), ts: Number(ts) * 1000, latestMs: Number(latest), maxMs: Number(max) }, now);
    }

    // Delta by entry id so each slow command is emitted exactly once.
    for (const [cmd, key] of [[['SLOWLOG', 'GET', String(t.logEntries)], 'lastSlowlogId'], [['COMMANDLOG', 'GET', String(t.logEntries), 'slow'], 'lastCommandlogId']] as const) {
      const entries = ((await n.client.call([...cmd]).catch(() => [])) as any[]) ?? [];
      // Entries logged before the collector started belong to a previous run.
      const fresh = entries.filter((e) => Number(e[0]) > n[key] && Number(e[1]) * 1000 >= startedAt).reverse();
      for (const e of fresh) emit(n.pod, role, cmd[0].toLowerCase(), { id: Number(e[0]), ts: Number(e[1]) * 1000, durationUs: Number(e[2]), args: (e[3] as any[]).slice(0, t.logArgs).map(String), client: String(e[5] ?? '') }, now);
      if (entries.length) n[key] = Math.max(n[key], ...entries.map((e) => Number(e[0])));
    }
  }

  await refreshPods();
  console.log(JSON.stringify({ truth: { started: Date.now(), nodes: nodes.size } }));
  let lastPods = Date.now();
  for (;;) {
    const now = Date.now();
    if (now - lastPods >= t.podRefreshSec * 1000) {
      await refreshPods().catch((e) => console.error(String(e)));
      lastPods = now;
    }
    const due = [...nodes.values()].filter((n) => n.nextAt <= now);
    await Promise.all(due.map(async (n) => {
      n.nextAt = now + (n.role === 'replica' ? t.replicaIntervalSec : t.primaryIntervalSec) * 1000;
      await sampleNode(n, now).catch((e) => emit(n.pod, n.role, 'collector_error', String(e).slice(0, 200), now));
    }));

    const primary = [...nodes.values()].find((n) => n.role === 'primary');
    if (primary && now - lastShards >= t.shardsIntervalSec * 1000) {
      lastShards = now;
      const shards = await primary.client.call(['CLUSTER', 'SHARDS']).catch((e) => String(e));
      out.write(JSON.stringify({ ts: now, pod: primary.pod.name, shard: primary.pod.shard, role: 'primary', metric: 'cluster_shards', value: shards }) + '\n');
    }
    if (now - lastSlotStats >= t.slotStatsIntervalSec * 1000) {
      lastSlotStats = now;
      await Promise.all([...nodes.values()].filter((n) => n.role === 'primary').map(async (n) => {
        const r = await n.client.call(['CLUSTER', 'SLOT-STATS', 'ORDERBY', 'cpu-usec', 'LIMIT', String(t.slotStatsLimit)]).catch((e) => String(e));
        emit(n.pod, 'primary', 'slot_stats_top_cpu', r, now);
      }));
    }
    await new Promise((r) => setTimeout(r, Math.max(10, t.tickMs - (Date.now() - now))));
  }
}
