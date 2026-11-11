import { execa } from 'execa';
import { kubectl } from '../../k8s.js';
import { valkeyCli } from '../../infra/verify.js';
import { waitHarnessJob } from '../../infra/harness.js';
import type { Phase } from '../phase.js';
import { tagForShard } from '../topology.js';
import { injectorJob, shardView, startInjector, stopInjector } from './util.js';

// O(N) reads of a 1M-member set on one shard (or DEBUG SLEEP via exec when
// enable-debug-command is `local`, which only accepts local connections).
export const slowCommands: Phase = {
  name: 'slowCommands',
  plannedSec: (cfg) => cfg.scenario.slowCommands.durationSec,
  summary: (cfg) => `shard ${cfg.scenario.slowCommands.shardIndex}: ${cfg.scenario.slowCommands.method} × ${cfg.scenario.slowCommands.calls}`,
  async inject(ctx) {
    const { cfg } = ctx;
    const p = cfg.scenario.slowCommands;
    const v = await shardView(ctx, p.shardIndex);
    const { tag } = tagForShard(v, p.hashTag);
    const key = `${tag}:bigset`;
    if (p.method === 'bigSet') {
      ctx.note(`preloading ${p.members} members into ${key}`);
      await startInjector(cfg, 'slowPreload', { kind: 'bigSet', key, members: p.members, batch: p.preloadBatch });
      await waitHarnessJob(cfg, injectorJob('slowPreload'), cfg.harness.jobTimeoutSec);
      ctx.note('preload done', { card: Number((await valkeyCli(cfg, v.primary.name, ['scard', key])).trim()) });
      const ts = await startInjector(cfg, 'slowCommands', { kind: 'smembers', key, calls: p.calls, durationSec: p.durationSec });
      return {
        ts, targetShard: p.shardIndex, targetPods: [v.primary.name],
        params: { method: p.method, key, members: p.members, calls: p.calls },
        expected: { patterns: ['slow_queries'], metrics: ['slowlog_last_id', 'slowlog_count', 'command_p99', 'large_reply_pressure'], nodes: [v.primary.name] },
        state: { key, pod: v.primary.name },
      };
    }
    // debugSleep: a detached exec loop inside the primary's server container.
    const gap = p.durationSec / p.calls;
    const script = `for i in $(seq ${p.calls}); do env -u VALKEYCLI_AUTH valkey-cli debug sleep ${p.debugSleepSec} >/dev/null; sleep ${gap}; done`;
    const proc = execa('kubectl', ['--context', `kind-${cfg.kind.clusterName}`, '-n', cfg.cluster.namespace, 'exec', v.primary.name, '-c', 'server', '--', 'sh', '-c', script], { reject: false });
    return {
      ts: Date.now(), targetShard: p.shardIndex, targetPods: [v.primary.name],
      params: { method: p.method, sleepSec: p.debugSleepSec, calls: p.calls },
      expected: { patterns: ['slow_queries'], metrics: ['slowlog_last_id', 'slowlog_count', 'command_p99'], nodes: [v.primary.name] },
      state: { pid: proc.pid, pod: v.primary.name },
    };
  },
  async revert(ctx, injected) {
    await stopInjector(ctx.cfg, 'slowCommands');
    await stopInjector(ctx.cfg, 'slowPreload');
    const st = injected?.state as { key?: string; pod?: string; pid?: number } | undefined;
    if (st?.pid) process.kill(st.pid, 'SIGTERM');
    if (st?.pod) await kubectl(ctx.cfg, ['-n', ctx.cfg.cluster.namespace, 'exec', st.pod, '-c', 'server', '--', 'sh', '-c', 'pkill -f "debug sleep" || true'], { reject: false });
    // The key's slot may have moved to another pod (failover); UNLINK through whichever primary owns it.
    if (st?.key) {
      const v = await shardView(ctx, ctx.cfg.scenario.slowCommands.shardIndex);
      await valkeyCli(ctx.cfg, v.primary.name, ['unlink', st.key]);
    }
  },
};
