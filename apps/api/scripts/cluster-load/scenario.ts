import { AsyncLocalStorage } from 'async_hooks';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import Valkey from 'iovalkey';
import { PORTS_EXHAUSTED } from './ports';
import { RemoteCluster } from './remote-cluster';

export interface ScenarioOptions {
  nodes: number;
  replicasPerShard: number;
  mode: 'seed' | 'auto';
  settleTimeoutMs: number;
  warmupMs: number;
  measureMs: number;
  hang: number;
  failover: boolean;
}

export interface PollerResult {
  intervalMs: number;
  ticks: number;
  expectedTicks: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  commandsPerTick: number;
  commandsPerSecond: number;
}

export interface InvalidRun {
  options: ScenarioOptions;
  invalid: string;
}

export interface ScenarioResult {
  options: ScenarioOptions;
  windowSeconds: number;
  connections: { registered: number; connected: number };
  server: {
    commandsPerSecond: number;
    bytesInPerSecond: number;
    bytesOutPerSecond: number;
    seedCommandsPerSecond: number;
    busiestNodeCommandsPerSecond: number;
    quietestNodeCommandsPerSecond: number;
    socketsOpen: number;
    socketsPeak: number;
    socketsOpened: number;
    commands: Array<{ command: string; perSecond: number; bytesOutPerSecond: number }>;
    unknownCommands: Record<string, number>;
  };
  pollers: Record<string, PollerResult>;
  process: {
    heapUsedMb: number;
    rssMb: number;
    cpuPercent: number;
    eventLoopDelayP50Ms: number;
    eventLoopDelayP99Ms: number;
    eventLoopDelayMaxMs: number;
  };
  webhookEvents: Record<string, number>;
  log: { warn: number; error: number; top: Array<{ message: string; count: number }> };
}

const BACKGROUND = 'background';
const FAILOVER_REQUESTED = 'cluster.failover (before the license check)';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number, digits = 1): number => Number(value.toFixed(digits));
const mb = (bytes: number): number => round(bytes / 1024 / 1024);

const percentile = (sorted: number[], fraction: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

class CountingLogger {
  warnCount = 0;
  errorCount = 0;
  portsExhausted = false;
  private readonly messages = new Map<string, number>();

  log(): void {}
  debug(): void {}
  verbose(): void {}
  fatal(message: unknown): void {
    this.error(message);
  }

  warn(message: unknown): void {
    this.warnCount += 1;
    this.remember('warn', message);
  }

  error(message: unknown): void {
    this.errorCount += 1;
    this.remember('error', message);
  }

  reset(): void {
    this.warnCount = 0;
    this.errorCount = 0;
    this.messages.clear();
  }

  top(limit: number): Array<{ message: string; count: number }> {
    return [...this.messages]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([message, count]) => ({ message, count }));
  }

  private remember(level: string, message: unknown): void {
    if (String(message).includes('EADDRNOTAVAIL')) this.portsExhausted = true;
    const text = `${level}: ${String(message)}`
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')
      .replace(/\d+/g, 'N')
      .slice(0, 160);
    this.messages.set(text, (this.messages.get(text) ?? 0) + 1);
  }
}

function applyEnvironment(options: ScenarioOptions, seed: { host: string; port: number }): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'betterdb-cluster-load-'));
  for (const key of ['BETTERDB_LICENSE_KEY', 'BETTERDB_OFFLINE_LICENSE', 'BETTERDB_OFFLINE_LICENSE_FILE', 'CLOUD_MODE']) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    STORAGE_TYPE: 'memory',
    DB_HOST: seed.host,
    DB_PORT: String(seed.port),
    DB_PASSWORD: '',
    DB_USERNAME: '',
    DB_TLS: 'false',
    AI_ENABLED: 'false',
    BETTERDB_TELEMETRY: 'false',
    WORKSPACE_DISABLED: 'true',
    BETTERDB_DATA_DIR: dataDir,
    MIGRATION_VERDICT_DIR: join(dataDir, 'migration-analysis-verdicts'),
    ENTITLEMENT_URL: 'http://127.0.0.1:9/api/v1/entitlements',
    CLUSTER_AUTO_REGISTER_NODES: options.mode === 'auto' ? 'true' : 'false',
  });
}

export async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const perShard = 1 + options.replicasPerShard;
  const cluster = await RemoteCluster.start({
    shards: Math.max(1, Math.round(options.nodes / perShard)),
    replicasPerShard: options.replicasPerShard,
  });
  applyEnvironment(options, cluster.nodes[0]);

  const context = new AsyncLocalStorage<string>();
  const clientCommands = new Map<string, number>();
  const prototype = Valkey.prototype as unknown as { sendCommand: (...args: unknown[]) => unknown };
  const sendCommand = prototype.sendCommand;
  prototype.sendCommand = function (this: unknown, ...args: unknown[]) {
    const owner = context.getStore() ?? BACKGROUND;
    clientCommands.set(owner, (clientCommands.get(owner) ?? 0) + 1);
    return sendCommand.apply(this, args);
  };

  const { NestFactory, ModulesContainer } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { AppModule } = require('../../src/app.module');
  const { MultiConnectionPoller } = require('../../src/common/services/multi-connection-poller');
  const { ConnectionRegistry } = require('../../src/connections/connection-registry.service');

  const logger = new CountingLogger();
  const pause = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (logger.portsExhausted) throw new Error(PORTS_EXHAUSTED);
      await sleep(Math.min(250, until - Date.now()));
    }
  };
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger });

  const tickDurations = new Map<string, number[]>();
  const intervals = new Map<string, number>();
  const webhookEvents = new Map<string, number>();
  const seen = new Set<unknown>();
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const wrapper of moduleRef.providers.values()) {
      const instance = wrapper.instance;
      if (!instance || seen.has(instance)) continue;
      seen.add(instance);
      if (instance instanceof MultiConnectionPoller) {
        const name = instance.constructor.name;
        const tick = instance.tick.bind(instance);
        tickDurations.set(name, []);
        intervals.set(name, instance.getIntervalMs());
        instance.tick = () =>
          context.run(name, async () => {
            const started = performance.now();
            try {
              await tick();
            } finally {
              tickDurations.get(name)?.push(performance.now() - started);
            }
          });
      }
      if (typeof instance.dispatchClusterFailover === 'function') {
        const dispatchClusterFailover = instance.dispatchClusterFailover.bind(instance);
        instance.dispatchClusterFailover = (...args: unknown[]) => {
          webhookEvents.set(FAILOVER_REQUESTED, (webhookEvents.get(FAILOVER_REQUESTED) ?? 0) + 1);
          return dispatchClusterFailover(...args);
        };
      }
      if (instance.constructor?.name === 'WebhookDispatcherService') {
        const dispatchEvent = instance.dispatchEvent.bind(instance);
        instance.dispatchEvent = (eventType: string, ...rest: unknown[]) => {
          webhookEvents.set(eventType, (webhookEvents.get(eventType) ?? 0) + 1);
          return dispatchEvent(eventType, ...rest);
        };
      }
    }
  }

  await app.init();
  const registry = app.get(ConnectionRegistry);
  const expected = options.mode === 'auto' ? cluster.nodes.length : 1;
  const deadline = Date.now() + options.settleTimeoutMs;
  while (Date.now() < deadline && registry.list().length < expected) await pause(1000);
  await pause(options.warmupMs);

  for (let index = 0; index < options.hang; index++) await cluster.hang(cluster.nodes.length - 1 - index);
  if (options.hang > 0) await pause(options.warmupMs);

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  await cluster.resetStats();
  clientCommands.clear();
  webhookEvents.clear();
  logger.reset();
  for (const durations of tickDurations.values()) durations.length = 0;
  loopDelay.enable();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();

  if (options.failover) {
    await pause(options.measureMs / 2);
    await cluster.failover(1);
    await pause(options.measureMs / 2);
  } else {
    await pause(options.measureMs);
  }

  const windowSeconds = (performance.now() - startedAt) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  loopDelay.disable();
  const stats = await cluster.stats();
  const ticks = new Map([...tickDurations].map(([name, durations]) => [name, [...durations].sort((a, b) => a - b)]));
  const commandsByOwner = new Map(clientCommands);
  const connections = registry.list() as Array<{ isConnected: boolean }>;
  (global as { gc?: () => void }).gc?.();
  const memory = process.memoryUsage();

  const pollers: Record<string, PollerResult> = {};
  for (const [name, sorted] of ticks) {
    const commands = commandsByOwner.get(name) ?? 0;
    const intervalMs = intervals.get(name) ?? 0;
    pollers[name] = {
      intervalMs,
      ticks: sorted.length,
      expectedTicks: intervalMs > 0 ? Math.floor((windowSeconds * 1000) / intervalMs) : 0,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
      commandsPerTick: sorted.length ? round(commands / sorted.length) : 0,
      commandsPerSecond: round(commands / windowSeconds),
    };
  }
  pollers[BACKGROUND] = {
    intervalMs: 0,
    ticks: 0,
    expectedTicks: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    commandsPerTick: 0,
    commandsPerSecond: round((commandsByOwner.get(BACKGROUND) ?? 0) / windowSeconds),
  };

  const result: ScenarioResult = {
    options,
    windowSeconds: round(windowSeconds),
    connections: {
      registered: connections.length,
      connected: connections.filter((connection) => connection.isConnected).length,
    },
    server: {
      commandsPerSecond: round(stats.totalCommands / windowSeconds),
      bytesInPerSecond: Math.round(stats.bytesIn / windowSeconds),
      bytesOutPerSecond: Math.round(stats.bytesOut / windowSeconds),
      seedCommandsPerSecond: round(stats.commandsByNode[0] / windowSeconds),
      busiestNodeCommandsPerSecond: round(Math.max(...stats.commandsByNode) / windowSeconds),
      quietestNodeCommandsPerSecond: round(Math.min(...stats.commandsByNode) / windowSeconds),
      socketsOpen: stats.connectionsOpen,
      socketsPeak: stats.peakConnections,
      socketsOpened: stats.connectionsOpened,
      commands: Object.entries(stats.commands)
        .map(([command, entry]) => ({
          command,
          perSecond: round(entry.count / windowSeconds),
          bytesOutPerSecond: Math.round(entry.bytesOut / windowSeconds),
        }))
        .sort((left, right) => right.bytesOutPerSecond - left.bytesOutPerSecond),
      unknownCommands: stats.unknownCommands,
    },
    pollers,
    process: {
      heapUsedMb: mb(memory.heapUsed),
      rssMb: mb(memory.rss),
      cpuPercent: round(((cpu.user + cpu.system) / 1000 / (windowSeconds * 1000)) * 100),
      eventLoopDelayP50Ms: round(loopDelay.percentile(50) / 1e6),
      eventLoopDelayP99Ms: round(loopDelay.percentile(99) / 1e6),
      eventLoopDelayMaxMs: round(loopDelay.max / 1e6),
    },
    webhookEvents: Object.fromEntries(webhookEvents),
    log: { warn: logger.warnCount, error: logger.errorCount, top: logger.top(8) },
  };

  await Promise.race([app.close().catch(() => undefined), sleep(5000)]);
  await cluster.stop();
  return result;
}

if (require.main === module) {
  const options = JSON.parse(process.env.CLUSTER_LOAD_SCENARIO ?? '{}') as ScenarioOptions;
  const resultFile = process.env.CLUSTER_LOAD_RESULT_FILE;
  runScenario(options)
    .then((result) => {
      if (resultFile) writeFileSync(resultFile, JSON.stringify(result, null, 2));
      else console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((failure) => {
      if (resultFile && failure instanceof Error && failure.message === PORTS_EXHAUSTED) {
        const invalid: InvalidRun = { options, invalid: PORTS_EXHAUSTED };
        writeFileSync(resultFile, JSON.stringify(invalid, null, 2));
        process.exit(0);
      }
      console.error(failure);
      process.exit(1);
    });
}
