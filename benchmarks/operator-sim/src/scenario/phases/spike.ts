import { setAppRps } from '../../load/memtier.js';
import type { Phase } from '../phase.js';

// Cluster-wide traffic burst: app-gen RPS × multiplier.
export const spike: Phase = {
  name: 'spike',
  plannedSec: (cfg) => cfg.scenario.spike.durationSec,
  summary: (cfg) => `app-gen ${cfg.load.app.rps} → ${cfg.load.app.rps * cfg.scenario.spike.multiplier} rps`,
  async inject(ctx) {
    const { cfg } = ctx;
    const rps = Math.round(cfg.load.app.rps * cfg.scenario.spike.multiplier);
    const ts = await setAppRps(cfg, rps);
    const primaries = [...(await ctx.topo()).values()].map((v) => v.primary.name);
    return {
      ts, targetShard: null, targetPods: primaries,
      params: { fromRps: cfg.load.app.rps, toRps: rps, multiplier: cfg.scenario.spike.multiplier },
      expected: { patterns: ['traffic_burst'], metrics: ['ops_per_sec', 'input_kbps', 'output_kbps', 'cpu_utilization'], nodes: primaries },
    };
  },
  async revert(ctx) {
    await setAppRps(ctx.cfg, ctx.cfg.load.app.rps);
  },
};
