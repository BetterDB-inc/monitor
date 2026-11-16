import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_IMAGE, IMAGE, laneSpec, mulberry32, shuffled, sleep } from './config';
import { docker, haltDocker, removeContainers, removeNetworks } from './docker';
import { HostWatch } from './host';
import { type Scenario, scenarios } from './scenarios';
import { runTrial, trialName } from './trial';

export interface RunOptions {
  outDir: string;
  lanes: number[];
  trials: number;
  only: string[] | null;
  seed: number;
  nodeTimeoutMs: number;
  clusterSize: number;
  maxLoad: number;
  minFreePorts: number;
  maxWaitMs: number;
}

export async function buildImage(contextDir: string): Promise<void> {
  await docker(['pull', BASE_IMAGE], 600_000);
  await docker(['build', '-t', IMAGE, contextDir], 600_000);
}

export async function down(): Promise<void> {
  await removeContainers('sbb-');
  await removeNetworks();
}

export function traceFile(outDir: string, scenario: string, rep: number): string {
  return join(outDir, scenario, `${trialName(scenario, rep)}.jsonl.gz`);
}

export async function run(options: RunOptions): Promise<{ done: number; failed: string[] }> {
  mkdirSync(options.outDir, { recursive: true });
  const logFile = join(options.outDir, 'run.log');
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    appendFileSync(logFile, `${stamped}\n`);
  };

  const wanted = scenarios(options.nodeTimeoutMs).filter(
    (scenario) => !options.only || options.only.includes(scenario.name),
  );
  const all: Array<{ scenario: Scenario; rep: number }> = [];
  for (let rep = 1; rep <= options.trials; rep++) {
    for (const scenario of wanted) all.push({ scenario, rep });
  }
  const queue = shuffled(all, mulberry32(options.seed)).filter(
    (item) => !existsSync(traceFile(options.outDir, item.scenario.name, item.rep)),
  );
  log(`queue: ${queue.length} trials (${all.length - queue.length} already recorded), lanes ${options.lanes.join(',')}`);

  const host = new HostWatch({ maxLoad: options.maxLoad, minFreePorts: options.minFreePorts });
  const before = await host.sample();
  log(
    `host: load ${before.load.toFixed(1)} (limit ${options.maxLoad}), ` +
      `${before.freePorts} free local ports (limit ${options.minFreePorts})`,
  );
  const busy = host.breach(before.load, before.freePorts);
  if (busy) {
    log(`refusing to record: ${busy}`);
    throw new Error(`refusing to record: ${busy}`);
  }
  host.start();

  let stopping = false;
  let halted: string | null = null;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: removing bench containers and networks`);
    void haltDocker()
      .then(down)
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const quiet = async (laneNumber: number): Promise<boolean> => {
    const deadline = Date.now() + options.maxWaitMs;
    for (let announced = false; !stopping && !halted; ) {
      const now = await host.sample();
      const reason = host.breach(now.load, now.freePorts);
      if (!reason) return true;
      if (!announced) log(`[lane ${laneNumber}] waiting: ${reason}`);
      announced = true;
      if (Date.now() > deadline) {
        halted = `${reason} for longer than ${Math.round(options.maxWaitMs / 60_000)} minutes`;
        log(`stopping the run: ${halted}`);
        return false;
      }
      await sleep(15_000);
    }
    return false;
  };

  const droppedFile = join(options.outDir, 'dropped.jsonl');
  const droppedBefore = (name: string): string[] =>
    existsSync(droppedFile)
      ? readFileSync(droppedFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { trial: string; reason: string })
          .filter((entry) => entry.trial === name)
          .map((entry) => entry.reason)
      : [];

  let done = 0;
  const failed: string[] = [];
  const total = queue.length;
  const worker = async (laneNumber: number) => {
    const lane = laneSpec(laneNumber, options.clusterSize);
    for (;;) {
      if (stopping || halted) return;
      const item = queue.shift();
      if (!item) return;
      const name = trialName(item.scenario.name, item.rep);
      for (let attempt = 1; attempt <= 3 && !stopping; attempt++) {
        if (!(await quiet(laneNumber))) return;
        const startedAt = Date.now();
        const dropped = droppedBefore(name);
        try {
          const meta = await runTrial({
            lane,
            scenario: item.scenario,
            rep: item.rep,
            seed: options.seed,
            nodeTimeoutMs: options.nodeTimeoutMs,
            file: traceFile(options.outDir, item.scenario.name, item.rep),
            host,
            attempt: dropped.length + 1,
            dropped,
          });
          done += 1;
          log(
            `[lane ${laneNumber}] ${name} ok ${Math.round((Date.now() - startedAt) / 1000)}s ` +
              `build=${meta.buildMs}ms late p50=${meta.late.p50} p99=${meta.late.p99} max=${meta.late.max} ` +
              `load=${meta.host.load.start.toFixed(1)}/${meta.host.load.max.toFixed(1)} ` +
              `ports=${meta.host.freePorts.min} vm=${meta.host.vmLoad.start.toFixed(1)}/${meta.host.vmLoad.end.toFixed(1)} ` +
              `attempt=${meta.attempt}${meta.lateOk ? '' : ' LATE'} (${done}/${total})`,
          );
          break;
        } catch (err) {
          if (stopping) return;
          const reason = (err as Error).message.slice(0, 200);
          appendFileSync(
            droppedFile,
            `${JSON.stringify({ trial: name, scenario: item.scenario.name, at: new Date().toISOString(), reason })}\n`,
          );
          log(`[lane ${laneNumber}] ${name} attempt ${dropped.length + 1} dropped: ${reason}`);
          if (attempt === 3) failed.push(name);
        }
      }
    }
  };
  const guarded = (laneNumber: number) =>
    worker(laneNumber).catch((err: Error) => {
      halted ??= err.message;
      log(`[lane ${laneNumber}] stopped: ${err.message}`);
    });
  try {
    await Promise.all(options.lanes.map(guarded));
  } finally {
    host.stop();
    if (!stopping) await down();
  }
  if (!stopping) {
    log(`finished: ${done} recorded, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
  }
  if (halted) throw new Error(`stopped the run: ${halted}`);
  return { done, failed };
}
