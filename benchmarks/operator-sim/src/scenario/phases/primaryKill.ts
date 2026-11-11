import { stringify } from 'yaml';
import { kubectl, kubectlApply } from '../../k8s.js';
import { waitClusterReady } from '../../infra/valkey.js';
import type { Phase } from '../phase.js';
import { dbsize, shardView } from './util.js';

const POD_CHAOS = 'bz-primary-kill';

// Kill one shard's primary. graceful = pod delete (operator sets shutdown-on-sigterm
// failover); hard = Chaos Mesh pod-kill, gracePeriod 0. Never container-kill: an
// in-place restart without persistence empties the shard (operator #533).
export const primaryKill: Phase = {
  name: 'primaryKill',
  plannedSec: (cfg) => cfg.scenario.primaryKill.expectedRecoverySec,
  summary: (cfg) => `shard ${cfg.scenario.primaryKill.shardIndex}: ${cfg.scenario.primaryKill.mode} kill of primary`,
  async inject(ctx) {
    const { cfg } = ctx;
    const p = cfg.scenario.primaryKill;
    const v = await shardView(ctx, p.shardIndex);
    const before = await dbsize(cfg, v.primary.name);
    if (p.mode === 'hard') ctx.note('hard kill without persistence: un-replicated writes on the primary are lost by design', { persistence: cfg.cluster.persistence });
    if (p.mode === 'graceful') await kubectl(cfg, ['-n', cfg.cluster.namespace, 'delete', 'pod', v.primary.name, '--wait=false']);
    else await kubectlApply(cfg, stringify({
      apiVersion: 'chaos-mesh.org/v1alpha1', kind: 'PodChaos',
      metadata: { name: POD_CHAOS, namespace: cfg.cluster.namespace, labels: { app: 'operator-sim' } },
      spec: { action: 'pod-kill', mode: 'all', gracePeriod: 0, selector: { namespaces: [cfg.cluster.namespace], fieldSelectors: { 'metadata.name': v.primary.name } } },
    }));
    return {
      ts: Date.now(), targetShard: p.shardIndex, targetPods: [v.primary.name, ...v.replicas.map((r) => r.name)],
      params: { mode: p.mode, killed: v.primary.name, dbsizeBefore: before },
      expected: { patterns: ['node_failover'], metrics: ['replication_role', 'cluster_topology', 'failover_churn', 'cluster_state'], nodes: [v.primary.name, ...v.replicas.map((r) => r.name)] },
      state: { killed: v.primary.name, before },
    };
  },
  // Done when another pod is primary for the shard and the cluster is Ready again.
  async hold(ctx, injected) {
    const { cfg } = ctx;
    const p = cfg.scenario.primaryKill;
    const killed = injected.state!.killed as string;
    const deadline = Date.now() + p.timeoutSec * 1000;
    for (;;) {
      const v = (await ctx.topo().catch(() => undefined))?.get(p.shardIndex);
      if (v && v.primary.name !== killed) {
        ctx.note('new primary', { pod: v.primary.name, afterMs: Date.now() - injected.ts });
        break;
      }
      if (ctx.aborted() || Date.now() > deadline) throw new Error(`no new primary for shard ${p.shardIndex} after ${p.timeoutSec}s`);
      await new Promise((r) => setTimeout(r, cfg.scenario.pollMs));
    }
    await waitClusterReady(cfg, p.timeoutSec);
    const v = await shardView(ctx, p.shardIndex);
    const after = await dbsize(cfg, v.primary.name);
    ctx.note('shard recovered', { primary: v.primary.name, replicas: v.replicas.map((r) => r.name), dbsizeBefore: injected.state!.before, dbsizeAfter: after, recoveredMs: Date.now() - injected.ts });
  },
  async revert(ctx) {
    await kubectl(ctx.cfg, ['-n', ctx.cfg.cluster.namespace, 'delete', 'podchaos', POD_CHAOS, '--ignore-not-found']);
    await waitClusterReady(ctx.cfg, ctx.cfg.scenario.primaryKill.timeoutSec);
  },
};
