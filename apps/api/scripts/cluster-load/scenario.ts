import { AsyncLocalStorage } from 'async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { Socket, type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import Valkey from 'iovalkey';
import type { ReplyProfile } from '../../test/load/fake-cluster';
import { PORTS_EXHAUSTED, portPressure, portsHeld } from './ports';
import { ProcessLoadMeter, type ProcessLoad } from './process-load';
import { RemoteCluster } from './remote-cluster';

export type LicenseTier = 'enterprise' | 'pro' | 'community';

export interface ScenarioOptions {
  nodes: number;
  replicasPerShard: number;
  mode: 'seed' | 'auto';
  settleTimeoutMs: number;
  warmupMs: number;
  measureMs: number;
  hang: number;
  failover: boolean;
  license: LicenseTier;
  profile: ReplyProfile;
  replyDelayMs: number;
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
  invalid?: string;
  suspect: string[];
  licenseTier: string;
  windowSeconds: number;
  connections: { expected: number; registered: number; connected: number };
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
    portsHeld: number;
    commands: Array<{ command: string; perSecond: number; bytesOutPerSecond: number }>;
    unknownCommands: Record<string, number>;
  };
  pollers: Record<string, PollerResult>;
  clientCommandsPerSecond: number;
  process: ProcessLoad & { heapUsedMb: number; rssAfterGcMb: number };
  fakeCluster: ProcessLoad;
  webhookEvents: Record<string, number>;
  clusterNodesCallers: Array<{ poller: string; caller: string; perSecond: number }>;
  log: { warn: number; error: number; top: Array<{ message: string; count: number }> };
}

const BACKGROUND = 'background';
const FAKE_LOOP_DELAY_LIMIT_MS = 20;
const LICENSE_WAIT_MS = 20_000;
const PLACEHOLDER_LICENSE_KEY = 'cluster-load-test-placeholder-not-a-license';

export class InvalidRunError extends Error {}
const FAILOVER_REQUESTED = 'cluster.failover (before the license check)';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number, digits = 1): number => Number(value.toFixed(digits));
const mb = (bytes: number): number => round(bytes / 1024 / 1024);

const percentile = (sorted: number[], fraction: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

const APP_FRAME = /at (?:async )?(\S+) \(.*?\/(?:apps\/api\/src|proprietary)\/(.*?)\.ts:\d+:\d+\)/;

function callSite(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const match = APP_FRAME.exec(line);
    if (!match || match[2].includes('database/adapters/')) continue;
    const frame = `${match[2].split('/').pop()}: ${match[1]}`;
    if (!frames.includes(frame)) frames.push(frame);
    if (frames.length === 2) break;
  }
  return frames.length ? frames.join(' < ') : 'unknown';
}

function watchForPortExhaustion(onExhausted: () => void): void {
  const prototype = Socket.prototype as unknown as { destroy: (error?: Error) => unknown };
  const destroy = prototype.destroy;
  prototype.destroy = function (this: unknown, error?: Error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EADDRNOTAVAIL') onExhausted();
    return destroy.call(this, error);
  };
}

async function startEntitlementStub(tier: LicenseTier): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ valid: true, tier, expiresAt: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/entitlements`;
}

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

function applyEnvironment(
  options: ScenarioOptions,
  seed: { host: string; port: number },
  entitlementUrl: string | null,
  dataDir: string,
): void {
  for (const key of [
    'BETTERDB_LICENSE_KEY',
    'BETTERDB_OFFLINE_LICENSE',
    'BETTERDB_OFFLINE_LICENSE_FILE',
    'CLOUD_MODE',
    'LICENSE_ALLOW_UNSIGNED',
  ]) {
    delete process.env[key];
  }
  if (entitlementUrl) {
    Object.assign(process.env, { BETTERDB_LICENSE_KEY: PLACEHOLDER_LICENSE_KEY, LICENSE_ALLOW_UNSIGNED: 'true' });
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
    ENTITLEMENT_URL: entitlementUrl ?? 'http://127.0.0.1:9/api/v1/entitlements',
    CLUSTER_AUTO_REGISTER_NODES: options.mode === 'auto' ? 'true' : 'false',
  });
}

export async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const perShard = 1 + options.replicasPerShard;
  const cluster = await RemoteCluster.start({
    shards: Math.max(1, Math.round(options.nodes / perShard)),
    replicasPerShard: options.replicasPerShard,
    profile: options.profile,
    replyDelayMs: options.replyDelayMs,
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'betterdb-cluster-load-'));
  try {
    return await measure(options, cluster, dataDir);
  } finally {
    await cluster.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function measure(options: ScenarioOptions, cluster: RemoteCluster, dataDir: string): Promise<ScenarioResult> {
  const entitlementUrl = options.license === 'community' ? null : await startEntitlementStub(options.license);
  applyEnvironment(options, cluster.nodes[0], entitlementUrl, dataDir);

  const context = new AsyncLocalStorage<string>();
  const clientCommands = new Map<string, number>();
  const clusterNodesCallers = new Map<string, number>();
  const counted = new WeakSet<object>();
  const prototype = Valkey.prototype as unknown as { sendCommand: (...args: unknown[]) => unknown };
  const sendCommand = prototype.sendCommand;
  prototype.sendCommand = function (this: unknown, ...args: unknown[]) {
    const command = args[0] as { name?: string; args?: unknown[] } | undefined;
    if (command && !counted.has(command)) {
      counted.add(command);
      const owner = context.getStore() ?? BACKGROUND;
      clientCommands.set(owner, (clientCommands.get(owner) ?? 0) + 1);
      if (command.name?.toLowerCase() === 'cluster' && String(command.args?.[0]).toLowerCase() === 'nodes') {
        const key = `${owner}\n${callSite()}`;
        clusterNodesCallers.set(key, (clusterNodesCallers.get(key) ?? 0) + 1);
      }
    }
    return sendCommand.apply(this, args);
  };

  const { NestFactory, ModulesContainer } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const { AppModule } = require('../../src/app.module');
  const { MultiConnectionPoller } = require('../../src/common/services/multi-connection-poller');
  const { ConnectionRegistry } = require('../../src/connections/connection-registry.service');

  const logger = new CountingLogger();
  watchForPortExhaustion(() => {
    logger.portsExhausted = true;
  });
  const pause = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (logger.portsExhausted) throw new InvalidRunError(PORTS_EXHAUSTED);
      await sleep(Math.min(250, until - Date.now()));
    }
  };
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger });
  let licenseTier = (): string => 'unknown';

  const tickDurations = new Map<string, number[]>();
  const intervals = new Map<string, number>();
  const webhookEvents = new Map<string, number>();
  const seen = new Set<unknown>();
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const wrapper of moduleRef.providers.values()) {
      const instance = wrapper.instance;
      if (!instance || seen.has(instance)) continue;
      seen.add(instance);
      if (instance.constructor?.name === 'LicenseService' && typeof instance.getLicenseTier === 'function') {
        licenseTier = () => String(instance.getLicenseTier());
      }
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
  const licensedBy = Date.now() + LICENSE_WAIT_MS;
  while (licenseTier() !== options.license && Date.now() < licensedBy) await pause(250);
  if (licenseTier() !== options.license) {
    throw new InvalidRunError(`the instance runs as "${licenseTier()}", the run asked for "${options.license}"`);
  }
  const registry = app.get(ConnectionRegistry);
  const expected = options.mode === 'auto' ? cluster.nodes.length : 1;
  const deadline = Date.now() + options.settleTimeoutMs;
  while (Date.now() < deadline && registry.list().length < expected) await pause(1000);
  if (registry.list().length < expected) {
    throw new InvalidRunError(
      `${registry.list().length} of ${expected} nodes registered within ${Math.round(options.settleTimeoutMs / 1000)}s`,
    );
  }
  await pause(options.warmupMs);

  for (let index = 0; index < options.hang; index++) await cluster.hang(cluster.nodes.length - 1 - index);
  if (options.hang > 0) await pause(options.warmupMs);

  const load = new ProcessLoadMeter();
  await cluster.resetStats();
  clientCommands.clear();
  clusterNodesCallers.clear();
  webhookEvents.clear();
  logger.reset();
  for (const durations of tickDurations.values()) durations.length = 0;
  load.start();
  const startedAt = performance.now();

  if (options.failover) {
    await pause(options.measureMs / 2);
    await cluster.failover(1);
    await pause(options.measureMs / 2);
  } else {
    await pause(options.measureMs);
  }

  const windowSeconds = (performance.now() - startedAt) / 1000;
  const processLoad = load.read();
  load.stop();
  const stats = await cluster.stats();
  const ticks = new Map([...tickDurations].map(([name, durations]) => [name, [...durations].sort((a, b) => a - b)]));
  const commandsByOwner = new Map(clientCommands);
  const nodesCallers = [...clusterNodesCallers]
    .map(([key, count]) => {
      const [poller, caller] = key.split('\n');
      return { poller, caller, perSecond: round(count / windowSeconds) };
    })
    .sort((left, right) => right.perSecond - left.perSecond);
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

  const connected = connections.filter((connection) => connection.isConnected).length;
  const socketsOpenedPerSecond = stats.connectionsOpened / windowSeconds;
  const suspect: string[] = [];
  if (stats.load.eventLoopDelayP99Ms > FAKE_LOOP_DELAY_LIMIT_MS) {
    suspect.push(
      `the fake cluster was late by ${stats.load.eventLoopDelayP99Ms} ms at p99 (limit ${FAKE_LOOP_DELAY_LIMIT_MS} ms), ` +
        'so slow replies may come from the fake and not from the monitor',
    );
  }
  const pressure = portPressure(stats.peakConnections, socketsOpenedPerSecond);
  if (pressure) suspect.push(`${pressure}, so connections may have failed for lack of ports`);
  const down = connections.length - connected;
  const invalid =
    down > options.hang
      ? `${down} of ${connections.length} registered connections were down at the end of the window`
      : undefined;

  const result: ScenarioResult = {
    options,
    ...(invalid ? { invalid } : {}),
    suspect,
    licenseTier: licenseTier(),
    windowSeconds: round(windowSeconds),
    connections: { expected, registered: connections.length, connected },
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
      portsHeld: portsHeld(stats.peakConnections, socketsOpenedPerSecond),
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
    clientCommandsPerSecond: round([...commandsByOwner.values()].reduce((sum, count) => sum + count, 0) / windowSeconds),
    process: { ...processLoad, heapUsedMb: mb(memory.heapUsed), rssAfterGcMb: mb(memory.rss) },
    fakeCluster: stats.load,
    webhookEvents: Object.fromEntries(webhookEvents),
    clusterNodesCallers: nodesCallers,
    log: { warn: logger.warnCount, error: logger.errorCount, top: logger.top(8) },
  };

  await Promise.race([app.close().catch(() => undefined), sleep(5000)]);
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
      if (resultFile && failure instanceof InvalidRunError) {
        const invalid: InvalidRun = { options, invalid: failure.message };
        writeFileSync(resultFile, JSON.stringify(invalid, null, 2));
        process.exit(0);
      }
      console.error(failure);
      process.exit(1);
    });
}
