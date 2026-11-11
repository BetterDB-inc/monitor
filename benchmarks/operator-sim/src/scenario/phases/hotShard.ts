import type { Phase } from '../phase.js';
import { tagForShard } from '../topology.js';
import { shardView, startInjector, stopInjector } from './util.js';

// One shard's primary hammered through a single hash tag (slot owner verified first).
export const hotShard: Phase = {
  name: 'hotShard',
  plannedSec: (cfg) => cfg.scenario.hotShard.durationSec,
  summary: (cfg) => `shard ${cfg.scenario.hotShard.shardIndex}: +${cfg.scenario.hotShard.rps} rps on ${cfg.scenario.hotShard.hashTag}`,
  async inject(ctx) {
    const p = ctx.cfg.scenario.hotShard;
    const v = await shardView(ctx, p.shardIndex);
    const { tag, slot, adjusted } = tagForShard(v, p.hashTag);
    if (adjusted) ctx.note(`${p.hashTag} hashes outside shard ${p.shardIndex}; using ${tag}`, { slot, configured: p.hashTag });
    const ts = await startInjector(ctx.cfg, 'hotShard', { kind: 'hot', tag, rps: p.rps, durationSec: p.durationSec + ctx.cfg.scenario.injectorGraceSec, keys: p.keys });
    return {
      ts, targetShard: p.shardIndex, targetPods: [v.primary.name],
      params: { tag, slot, rps: p.rps, keys: p.keys },
      expected: { patterns: ['traffic_burst'], metrics: ['ops_per_sec', 'cpu_utilization', 'input_kbps', 'output_kbps', 'reshard_shard_skew'], nodes: [v.primary.name] },
    };
  },
  async revert(ctx) {
    await stopInjector(ctx.cfg, 'hotShard');
  },
};
