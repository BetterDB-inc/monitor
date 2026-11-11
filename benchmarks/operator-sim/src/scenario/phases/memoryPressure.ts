import { valkeyCli } from '../../infra/verify.js';
import type { Phase } from '../phase.js';
import { tagForShard } from '../topology.js';
import { shardView, startInjector, stopInjector } from './util.js';

// Shrink one primary's maxmemory under a new-key write flood → evictions.
// The operator owns maxmemory as a live config key, so ground truth also records
// whether it reconciles our CONFIG SET back during the phase.
export const memoryPressure: Phase = {
  name: 'memoryPressure',
  plannedSec: (cfg) => cfg.scenario.memoryPressure.durationSec,
  summary: (cfg) => `shard ${cfg.scenario.memoryPressure.shardIndex}: maxmemory → ${cfg.scenario.memoryPressure.maxmemory} + ${cfg.scenario.memoryPressure.writeRps} new keys/s`,
  async inject(ctx) {
    const { cfg } = ctx;
    const p = cfg.scenario.memoryPressure;
    const v = await shardView(ctx, p.shardIndex);
    const original = (await valkeyCli(cfg, v.primary.name, ['config', 'get', 'maxmemory'])).trim().split('\n')[1]!;
    await valkeyCli(cfg, v.primary.name, ['config', 'set', 'maxmemory', p.maxmemory]);
    const ts = Date.now();
    const { tag } = tagForShard(v, p.hashTag);
    await startInjector(cfg, 'memoryPressure', { kind: 'write', tag, rps: p.writeRps, durationSec: p.durationSec + cfg.scenario.injectorGraceSec, valueBytes: p.valueBytes, uniqueKeys: true, keySpace: 1 });
    return {
      ts, targetShard: p.shardIndex, targetPods: [v.primary.name],
      params: { maxmemory: p.maxmemory, originalMaxmemory: original, tag, writeRps: p.writeRps, valueBytes: p.valueBytes },
      expected: { patterns: ['memory_pressure', 'cache_thrashing'], metrics: ['evicted_keys', 'memory_used', 'keyspace_misses', 'memory_overhead'], nodes: [v.primary.name] },
      state: { pod: v.primary.name, original },
    };
  },
  async revert(ctx, injected) {
    await stopInjector(ctx.cfg, 'memoryPressure');
    const st = injected?.state as { pod?: string; original?: string } | undefined;
    // Restore on whichever pod is primary now, and on the original pod if it still exists.
    const v = await shardView(ctx, ctx.cfg.scenario.memoryPressure.shardIndex);
    for (const pod of new Set([v.primary.name, st?.pod].filter(Boolean) as string[]))
      await valkeyCli(ctx.cfg, pod, ['config', 'set', 'maxmemory', st?.original ?? ctx.cfg.cluster.maxmemory]).catch(() => undefined);
  },
};
