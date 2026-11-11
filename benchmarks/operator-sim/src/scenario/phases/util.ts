import type { SimConfig } from '../../config.js';
import { deleteHarnessJob, startHarnessJob } from '../../infra/harness.js';
import { valkeyCli } from '../../infra/verify.js';
import type { InjectSpec } from '../../load/inject.js';
import type { PhaseCtx } from '../phase.js';
import type { ShardView } from '../topology.js';

export const injectorJob = (phase: string) => `inj-${phase.toLowerCase()}`;

export async function startInjector(cfg: SimConfig, phase: string, spec: InjectSpec) {
  await startHarnessJob(cfg, injectorJob(phase), ['inject'], { INJECT: JSON.stringify(spec) });
  return Date.now();
}

export const stopInjector = (cfg: SimConfig, phase: string) => deleteHarnessJob(cfg, injectorJob(phase));

export async function shardView(ctx: PhaseCtx, shard: number): Promise<ShardView> {
  const v = (await ctx.topo()).get(shard);
  if (!v) throw new Error(`shard ${shard} has no primary in CLUSTER NODES`);
  return v;
}

export const dbsize = async (cfg: SimConfig, pod: string) => Number((await valkeyCli(cfg, pod, ['dbsize'])).trim());
