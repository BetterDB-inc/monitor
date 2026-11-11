import { stringify } from 'yaml';
import { kubectl, kubectlApply } from '../../k8s.js';
import type { Phase } from '../phase.js';
import { tagForShard } from '../topology.js';
import { shardView, startInjector, stopInjector } from './util.js';

const DELAY = 'bz-replica-lag-delay';
const BW = 'bz-replica-lag-bw';

// Slow the primary → one replica link (delay + bandwidth) under a write burst.
// Chaos is applied on the primary's egress with the replica as target: replication
// data flows primary → replica, so shaping the replica's own egress would only delay ACKs.
export const replicaLag: Phase = {
  name: 'replicaLag',
  plannedSec: (cfg) => cfg.scenario.replicaLag.durationSec,
  summary: (cfg) => `shard ${cfg.scenario.replicaLag.shardIndex}: ${cfg.scenario.replicaLag.latencyMs}ms + ${cfg.scenario.replicaLag.bandwidth} to one replica, ${cfg.scenario.replicaLag.writeBurstRps} writes/s`,
  async inject(ctx) {
    const { cfg } = ctx;
    const p = cfg.scenario.replicaLag;
    const v = await shardView(ctx, p.shardIndex);
    const replica = v.replicas[0];
    if (!replica) throw new Error(`shard ${p.shardIndex} has no replica`);
    const base = (name: string) => ({
      apiVersion: 'chaos-mesh.org/v1alpha1', kind: 'NetworkChaos',
      metadata: { name, namespace: cfg.cluster.namespace, labels: { app: 'operator-sim' } },
      spec: {
        mode: 'all', selector: { namespaces: [cfg.cluster.namespace], fieldSelectors: { 'metadata.name': v.primary.name } },
        direction: 'to', target: { mode: 'all', selector: { namespaces: [cfg.cluster.namespace], fieldSelectors: { 'metadata.name': replica.name } } },
        duration: `${p.durationSec + cfg.scenario.injectorGraceSec}s`,
      },
    });
    const delay = base(DELAY);
    Object.assign(delay.spec, { action: 'delay', delay: { latency: `${p.latencyMs}ms`, jitter: '0ms', correlation: '0' } });
    const bw = base(BW);
    Object.assign(bw.spec, { action: 'bandwidth', bandwidth: { rate: p.bandwidth, limit: p.bandwidthLimitBytes, buffer: p.bandwidthBufferBytes } });
    await kubectlApply(cfg, [delay, bw].map((o) => stringify(o)).join('---\n'));
    const ts = Date.now();
    const { tag } = tagForShard(v, p.hashTag);
    await startInjector(cfg, 'replicaLag', { kind: 'write', tag, rps: p.writeBurstRps, durationSec: p.durationSec, valueBytes: p.valueBytes, uniqueKeys: false, keySpace: p.keySpace });
    return {
      ts, targetShard: p.shardIndex, targetPods: [v.primary.name, replica.name],
      params: { primary: v.primary.name, replica: replica.name, latencyMs: p.latencyMs, bandwidth: p.bandwidth, writeBurstRps: p.writeBurstRps, tag },
      expected: { patterns: ['replication_divergence'], metrics: ['replication_divergence', 'repl_buffer_pressure', 'resync_loop', 'backlog_coverage_risk'], nodes: [v.primary.name, replica.name] },
    };
  },
  async revert(ctx) {
    await stopInjector(ctx.cfg, 'replicaLag');
    await kubectl(ctx.cfg, ['-n', ctx.cfg.cluster.namespace, 'delete', 'networkchaos', DELAY, BW, '--ignore-not-found', '--wait']);
  },
};
