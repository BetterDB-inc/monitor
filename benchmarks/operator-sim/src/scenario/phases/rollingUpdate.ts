import { kubectl, kubectlJson } from '../../k8s.js';
import { waitClusterReady } from '../../infra/valkey.js';
import type { Phase } from '../phase.js';

// Operator-driven image roll. Tracks, per pod, when it came back on the new image and,
// per shard, when its primary moved. No-synced-replica windows (operator #563) are
// computed by the report from ground truth (master_link_status / sync_in_progress).
export const rollingUpdate: Phase = {
  name: 'rollingUpdate',
  plannedSec: (cfg) => cfg.scenario.rollingUpdate.expectedSec,
  summary: (cfg) => `${cfg.cluster.valkeyImage} → ${cfg.cluster.rollToImage}`,
  async inject(ctx) {
    const { cfg } = ctx;
    const vc = await kubectlJson(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeycluster', cfg.cluster.name]);
    const from = vc.spec.image as string;
    if (from === cfg.cluster.rollToImage) ctx.note(`already on ${from}; run \`make reset\` to restore ${cfg.cluster.valkeyImage}`);
    // Snapshot before the patch: once the roll starts, pods restart under us.
    const pods = [...(await ctx.topo()).values()].flatMap((v) => [v.primary.name, ...v.replicas.map((r) => r.name)]);
    await kubectl(cfg, ['-n', cfg.cluster.namespace, 'patch', 'valkeycluster', cfg.cluster.name, '--type', 'merge', '-p', JSON.stringify({ spec: { image: cfg.cluster.rollToImage } })]);
    const ts = Date.now();
    return {
      ts, targetShard: null, targetPods: pods,
      params: { from, to: cfg.cluster.rollToImage },
      expected: { patterns: ['node_failover'], metrics: ['replication_role', 'cluster_topology', 'failover_churn'], nodes: pods },
    };
  },
  async hold(ctx, injected) {
    const { cfg } = ctx;
    const r = cfg.scenario.rollingUpdate;
    const to = cfg.cluster.rollToImage;
    const deadline = Date.now() + r.timeoutSec * 1000;
    const rolled = new Set<string>();
    const primaries = new Map<number, string>();
    for (const [s, v] of await ctx.topo()) primaries.set(s, v.primary.name);
    for (;;) {
      const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', cfg.cluster.namespace, 'get', 'pods', '-l', `valkey.io/cluster=${cfg.cluster.name}`]);
      for (const p of pods.items) {
        const server = p.spec.containers.find((c: any) => c.name === 'server');
        const ready = (p.status.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True');
        if (server?.image === to && ready && !rolled.has(p.metadata.name)) {
          rolled.add(p.metadata.name);
          ctx.note('pod rolled', { pod: p.metadata.name, shard: Number(p.metadata.labels['valkey.io/shard-index']), afterMs: Date.now() - injected.ts, done: rolled.size });
        }
      }
      const topo = await ctx.topo().catch(() => undefined);
      for (const [s, v] of topo ?? []) {
        if (primaries.get(s) !== v.primary.name) {
          ctx.note('primary moved', { shard: s, from: primaries.get(s), to: v.primary.name, afterMs: Date.now() - injected.ts });
          primaries.set(s, v.primary.name);
        }
      }
      if (rolled.size === pods.items.length && pods.items.length === cfg.cluster.shards * (1 + cfg.cluster.replicasPerShard)) break;
      if (ctx.aborted()) return;
      if (Date.now() > deadline) throw new Error(`roll incomplete after ${r.timeoutSec}s: ${rolled.size}/${pods.items.length}`);
      await new Promise((res) => setTimeout(res, cfg.scenario.pollMs));
    }
    await waitClusterReady(cfg, r.timeoutSec);
  },
  // The image change is not undone here (that's another full roll); `make reset` restores it.
  async revert(ctx) {
    await waitClusterReady(ctx.cfg, ctx.cfg.scenario.rollingUpdate.timeoutSec);
  },
};
