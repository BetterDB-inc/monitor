import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const shardIndex = z.number().int().nonnegative();
const durationSec = z.number().int().positive();
const hashTag = z.string().regex(/^\{.+\}$/);

const PHASES = ['spike', 'hotShard', 'slowCommands', 'memoryPressure', 'replicaLag', 'primaryKill', 'rollingUpdate'] as const;

export const SimConfig = z
  .object({
    seed: z.number().int(),
    cluster: z.object({
      name: z.string().min(1).max(41),
      namespace: z.string(),
      shards: z.number().int().min(3),
      replicasPerShard: z.number().int().nonnegative(),
      valkeyImage: z.string(),
      rollToImage: z.string(),
      persistence: z.boolean(),
      resources: z.object({ cpu: z.string(), memoryRequest: z.string(), memoryLimit: z.string() }),
      exporterResources: z.object({ cpu: z.string(), memory: z.string() }),
      maxmemory: z.string(),
      maxmemoryPolicy: z.string(),
      slowlogSlowerThanUs: z.number().int(),
      latencyMonitorThresholdMs: z.number().int(),
      enableDebugCommand: z.enum(['yes', 'no', 'local']),
      readyTimeoutSec: durationSec,
      usersSecret: z.string(),
      pollSec: z.number().positive(),
    }),
    operator: z.object({ namespace: z.string() }),
    chaos: z.object({ namespace: z.string() }),
    harness: z.object({ namespace: z.string(), imageRepo: z.string(), startTimeoutSec: durationSec, jobTimeoutSec: durationSec }),
    clients: z.object({ requestTimeoutMs: z.number().int().positive(), injectRequestTimeoutMs: z.number().int().positive(), smokeConcurrency: z.number().int().positive() }),
    kind: z.object({
      clusterName: z.string(),
      workers: z.number().int().positive(),
      zones: z.number().int().positive(),
      nodeImage: z.string(),
    }),
    dataset: z.object({
      keys: z.number().int().positive(),
      mix: z.object({ profiles: z.number(), counters: z.number(), dedupSets: z.number(), inboxes: z.number() }),
      valueBytes: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      setMembers: z.number().int().positive(),
      memberBytes: z.number().int().positive(),
      overheadBytes: z.object({ key: z.number().int().nonnegative(), field: z.number().int().nonnegative() }),
      maxFillRatio: z.number().gt(0).lt(1),
      skipTolerance: z.number().gt(0).lt(1),
      warmBatch: z.number().int().positive(),
      warmConcurrency: z.number().int().positive(),
      warmProgressEvery: z.number().int().positive(),
      warmRequestTimeoutMs: z.number().int().positive(),
    }),
    load: z.object({
      memtier: z.object({
        image: z.string(),
        zipfExp: z.number().gt(0).lt(5),
        keyPrefix: z.string(),
        keyMaximum: z.number().int().positive(),
        dataSizeRange: z.string().regex(/^\d+-\d+$/),
        collectGraceSec: durationSec,
        cpu: z.string(),
        clients: z.number().int().positive(),
        threads: z.number().int().positive(),
        ratio: z.string().regex(/^\d+:\d+$/),
        keyPattern: z.string().regex(/^[RSGPZ]:[RSGPZ]$/),
        ratePerConn: z.number().int().positive(),
        pipeline: z.number().int().positive(),
      }),
      app: z.object({
        rps: z.number().int().positive(),
        replicas: z.number().int().positive(),
        controlFile: z.string().startsWith('/'),
        tickMs: z.number().int().positive(),
        rateLimitTtlSec: durationSec,
        dedupMemberSpace: z.number().int().positive(),
        inboxKeep: z.number().int().positive(),
        cpu: z.string(),
        memory: z.string(),
        mix: z.object({
          profileHGET: z.number(),
          counterINCR: z.number(),
          rateLimitINCRBY_EXPIRE: z.number(),
          dedupSADD_SISMEMBER: z.number(),
          zsetZADD_ZRANGE: z.number(),
        }),
      }),
      steady: z.object({ durationSec, settleSec: durationSec, balanceTolerance: z.number().positive(), p99StabilityQuantile: z.number().gt(0).lt(1), p99StabilityFactor: z.number().positive() }),
    }),
    scenario: z.object({
      baselineSec: durationSec,
      gapSec: durationSec,
      phases: z.array(z.enum(PHASES)),
      injectorGraceSec: z.number().int().nonnegative(),
      pollMs: z.number().int().positive(),
      bannerEverySec: durationSec,
      countdownFinalSec: z.number().int().nonnegative(),
      loadOverrunSec: durationSec,
      spike: z.object({ multiplier: z.number().positive(), durationSec }),
      hotShard: z.object({ shardIndex, hashTag, rps: z.number().int().positive(), keys: z.number().int().positive(), durationSec }),
      slowCommands: z.object({ shardIndex, hashTag, method: z.enum(['bigSet', 'debugSleep']), members: z.number().int().positive(), preloadBatch: z.number().int().positive(), calls: z.number().int().positive(), debugSleepSec: z.number().positive(), durationSec }),
      memoryPressure: z.object({ shardIndex, hashTag, maxmemory: z.string(), writeRps: z.number().int().positive(), valueBytes: z.number().int().positive(), durationSec }),
      replicaLag: z.object({ shardIndex, hashTag, latencyMs: z.number().int().positive(), bandwidth: z.string(), bandwidthLimitBytes: z.number().int().positive(), bandwidthBufferBytes: z.number().int().positive(), writeBurstRps: z.number().int().positive(), valueBytes: z.number().int().positive(), keySpace: z.number().int().positive(), durationSec }),
      primaryKill: z.object({ shardIndex, mode: z.enum(['graceful', 'hard']), expectedRecoverySec: durationSec, timeoutSec: durationSec }),
      rollingUpdate: z.object({ enabled: z.boolean(), expectedSec: durationSec, timeoutSec: durationSec }),
    }),
    screenshots: z.object({
      enabled: z.boolean(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      settleMs: z.number().int().nonnegative(),
      timeoutMs: z.number().int().positive(),
      panels: z.record(z.string(), z.object({
        view: z.enum(['cluster', 'node']),
        tab: z.string().optional(),
        anchor: z.string(),
        container: z.string().optional(),
        clip: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      })),
    }),
    prospect: z.object({
      windowPadSec: z.number().int().nonnegative(),
      shots: z.array(z.string()),
      buildLabel: z.string(),
      signature: z.string(),
      slowlogMetrics: z.array(z.string()),
      notes: z.object({ zeroReplica: z.string(), ghostMaster: z.string(), plannedRolls: z.string(), slowCommands: z.string(), repro: z.string() }),
      captions: z.record(z.string(), z.string()),
    }),
    report: z.object({
      warmupSec: durationSec,
      onsetBaselineSec: durationSec,
      opsOnsetFactor: z.number().gt(1),
      replLagOnsetBytes: z.number().int().positive(),
      maxMatchedPerPhase: z.number().int().positive(),
      textChars: z.number().int().positive(),
      chromiumPath: z.string(),
    }),
    truth: z.object({
      file: z.string().startsWith('/'),
      primaryIntervalSec: z.number().positive(),
      replicaIntervalSec: z.number().positive(),
      shardsIntervalSec: z.number().positive(),
      viewIntervalSec: z.number().positive(),
      slotStatsIntervalSec: z.number().positive(),
      slotStatsLimit: z.number().int().positive(),
      podRefreshSec: z.number().positive(),
      tickMs: z.number().int().positive(),
      requestTimeoutMs: z.number().int().positive(),
      clientName: z.string(),
      logEntries: z.number().int().positive(),
      logArgs: z.number().int().positive(),
      cpu: z.string(),
      memory: z.string(),
      smokeSec: durationSec,
      infoFields: z.array(z.string()),
    }),
    betterdb: z.object({
      namespace: z.string(),
      url: z.string().url(),
      nodePort: z.number().int().min(30000).max(32767),
      release: z.string(),
      readyTimeoutSec: durationSec,
      requestTimeoutMs: z.number().int().positive(),
      eventLimit: z.number().int().positive(),
      verify: z.object({ registerCycles: z.number().int().positive(), syncIntervalSec: durationSec, churnWatchSec: durationSec, healthyCoverageReasons: z.array(z.string()) }),
      valkeyUser: z.string().regex(/^[a-z][a-z0-9-]*$/),
      valkeyAcl: z.string(),
      imageTag: z.string(),
      buildRef: z.string().optional(),
      pollSec: z.number().positive(),
      matchWindowSec: durationSec,
    }),
    charts: z.record(z.string(), z.object({ repo: z.string().url(), chart: z.string(), version: z.string() })),
  })
  .superRefine((c, ctx) => {
    for (const [path, mix] of [[['load', 'app', 'mix'], c.load.app.mix], [['dataset', 'mix'], c.dataset.mix]] as const) {
      const sum = Object.values(mix).reduce((a: number, b: number) => a + b, 0);
      if (Math.abs(sum - 1) > 1e-6) ctx.addIssue({ code: 'custom', path: [...path], message: `mix sums to ${sum}, expected 1` });
    }
    for (const p of ['hotShard', 'slowCommands', 'memoryPressure', 'replicaLag', 'primaryKill'] as const) {
      if (c.scenario[p].shardIndex >= c.cluster.shards)
        ctx.addIssue({ code: 'custom', path: ['scenario', p, 'shardIndex'], message: `>= cluster.shards (${c.cluster.shards})` });
    }
  });

export type SimConfig = z.infer<typeof SimConfig>;
export type PhaseName = (typeof PHASES)[number];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

// SIM_OVERRIDES: JSON deep-merged over sim.yaml (arrays replace), e.g. short smoke timings.
export function loadConfig(path = process.env.SIM_CONFIG ?? new URL('../config/sim.yaml', import.meta.url).pathname): SimConfig {
  const base = parse(readFileSync(path, 'utf8'));
  return SimConfig.parse(process.env.SIM_OVERRIDES ? deepMerge(base, JSON.parse(process.env.SIM_OVERRIDES)) : base);
}
