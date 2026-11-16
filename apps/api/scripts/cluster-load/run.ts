import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { portProblem } from './ports';
import type { InvalidRun, LicenseTier, ScenarioOptions, ScenarioResult } from './scenario';
import type { ReplyProfile } from '../../test/load/fake-cluster';

const CHILD_MARGIN_MS = 180_000;

interface CliOptions {
  nodes: number[];
  modes: Array<'seed' | 'auto'>;
  replicas: number;
  warmupSeconds: number;
  measureSeconds: number;
  settleSeconds: number;
  hang: number;
  failover: boolean;
  license: LicenseTier;
  profile: ReplyProfile;
  replyDelayMs: number;
  force: boolean;
  out?: string;
}

const USAGE = `Usage: pnpm load:cluster [options]

  --nodes 100,250,500   cluster sizes to run (default 100,250,500)
  --modes seed,auto     seed = one registered connection, auto = every node registered (default both)
  --replicas 1          replicas per shard (default 1)
  --warmup 30           seconds to wait before measuring (default 30)
  --measure 120         seconds measured (default 120)
  --settle 300          longest wait for auto-registration, seconds (default 300)
  --hang 0              nodes that accept TCP and stop replying (default 0)
  --failover            promote a replica of shard 1 halfway through the window
  --license pro         pro or enterprise = licensed features on, through a local stand-in
                        for the license server; community = no license (default pro)
  --profile realistic   realistic = filled slow log, command log, latency events, 200 clients,
                        60 commands in the stats and a keyspace to scan; empty = near-empty replies
                        (default realistic)
  --reply-delay-ms 0    hold every reply back this long, to stand in for a network (default 0)
  --out <dir>           also write one JSON file per run and report.md there
  --force               run even when the size does not fit the local port range

Every connection from the API to a fake node takes one local port. With one
registered connection that is about one port per node (500 nodes: about 500).
With every node registered it is nodes x nodes (100 nodes: 10,000; 500 nodes:
250,000). A run that would take more than half of the machine's local port
range is skipped unless --force is given, and a run that runs out of ports is
stopped and reported as invalid. A closed connection keeps its port for about
30 seconds more, so a run that opens and closes many connections is marked
suspect when open plus recently closed ports pass half of the range.
`;

function parseLicense(value: string): LicenseTier {
  return value === 'community' || value === 'enterprise' ? value : 'pro';
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    nodes: [100, 250, 500],
    modes: ['seed', 'auto'],
    replicas: 1,
    warmupSeconds: 30,
    measureSeconds: 120,
    settleSeconds: 300,
    hang: 0,
    failover: false,
    license: 'pro',
    profile: 'realistic',
    replyDelayMs: 0,
    force: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = (): string => argv[++index] ?? '';
    switch (flag) {
      case '--nodes':
        options.nodes = value().split(',').map(Number).filter((count) => count > 1);
        break;
      case '--modes':
        options.modes = value().split(',').filter((mode): mode is 'seed' | 'auto' => mode === 'seed' || mode === 'auto');
        break;
      case '--replicas':
        options.replicas = Number(value());
        break;
      case '--warmup':
        options.warmupSeconds = Number(value());
        break;
      case '--measure':
        options.measureSeconds = Number(value());
        break;
      case '--settle':
        options.settleSeconds = Number(value());
        break;
      case '--hang':
        options.hang = Number(value());
        break;
      case '--failover':
        options.failover = true;
        break;
      case '--license':
        options.license = parseLicense(value());
        break;
      case '--profile':
        options.profile = value() === 'empty' ? 'empty' : 'realistic';
        break;
      case '--reply-delay-ms':
        options.replyDelayMs = Math.max(0, Number(value()) || 0);
        break;
      case '--force':
        options.force = true;
        break;
      case '--out':
        options.out = value();
        break;
      case '--':
        break;
      default:
        process.stdout.write(USAGE);
        process.exit(flag === '--help' || flag === '-h' ? 0 : 1);
    }
  }
  return options;
}

function runChild(scenario: ScenarioOptions, workDir: string): ScenarioResult | InvalidRun {
  const label = `${scenario.nodes}-${scenario.mode}`;
  const resultFile = join(workDir, `${label}.json`);
  const stages = scenario.hang > 0 ? 2 : 1;
  const timeoutMs = scenario.settleTimeoutMs + scenario.warmupMs * stages + scenario.measureMs + CHILD_MARGIN_MS;
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=8192',
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
      join(__dirname, 'scenario.ts'),
    ],
    {
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, CLUSTER_LOAD_SCENARIO: JSON.stringify(scenario), CLUSTER_LOAD_RESULT_FILE: resultFile },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  );
  if (child.status !== 0) {
    const reason =
      child.signal || child.error
        ? `stopped after ${Math.round(timeoutMs / 1000)}s without finishing`
        : `failed with exit code ${child.status}`;
    const errorLine = (child.stderr ?? '')
      .split('\n')
      .reverse()
      .find((line) => /^\w*Error: /.test(line.trim()))
      ?.trim()
      .slice(0, 200);
    process.stderr.write(`Run ${label} ${reason}\n${(child.stderr ?? '').slice(-2000)}\n`);
    return { options: scenario, invalid: errorLine ? `${reason} (${errorLine})` : reason };
  }
  return JSON.parse(readFileSync(resultFile, 'utf8')) as ScenarioResult | InvalidRun;
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1);
const label = (result: { options: ScenarioOptions }): string =>
  `${result.options.nodes} nodes, ${result.options.mode === 'seed' ? 'seed only' : 'every node registered'}`;

function table(headers: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function summary(results: ScenarioResult[]): string {
  return table(
    [
      'Nodes',
      'Mode',
      'License',
      'Replies',
      'Reply delay ms',
      'Connections',
      'Sockets',
      'Ports held',
      'Commands/s',
      'KB/s in',
      'KB/s out',
      'Busiest node cmd/s',
      'Anomaly tick p50 / p95 ms',
      'Loop delay p99 ms',
      'CPU %',
      'Heap MB',
      'RSS peak MB',
      'Fake cluster CPU %',
      'Fake cluster loop delay p99 ms',
      'Suspect',
    ],
    results.map((result) => {
      const anomaly = result.pollers.AnomalyService;
      return [
        result.options.nodes,
        result.options.mode,
        result.licenseTier,
        result.options.profile,
        result.options.replyDelayMs,
        `${result.connections.connected}/${result.connections.registered}`,
        result.server.socketsOpen,
        result.server.portsHeld,
        result.server.commandsPerSecond,
        kb(result.server.bytesInPerSecond),
        kb(result.server.bytesOutPerSecond),
        result.server.busiestNodeCommandsPerSecond,
        anomaly ? `${anomaly.p50Ms} / ${anomaly.p95Ms}` : '-',
        result.process.eventLoopDelayP99Ms,
        result.process.cpuPercent,
        result.process.heapUsedMb,
        result.process.rssPeakMb,
        result.fakeCluster.cpuPercent,
        result.fakeCluster.eventLoopDelayP99Ms,
        result.suspect.length ? 'yes' : '-',
      ];
    }),
  );
}

function details(result: ScenarioResult): string {
  const commands = table(
    ['Command', 'Per second', 'KB/s out'],
    result.server.commands
      .filter((entry) => entry.perSecond >= 0.1)
      .slice(0, 15)
      .map((entry) => [entry.command, entry.perSecond, kb(entry.bytesOutPerSecond)]),
  );
  const pollers = table(
    [
      'Poller',
      'Interval ms',
      'Ticks done / expected',
      'Tick p50 ms',
      'Tick p95 ms',
      'Tick max ms',
      'Commands per tick',
      'Commands/s, counted in the monitor',
    ],
    Object.entries(result.pollers)
      .filter(([, poller]) => poller.commandsPerSecond > 0 || poller.ticks > 0)
      .sort((left, right) => right[1].commandsPerSecond - left[1].commandsPerSecond)
      .map(([name, poller]) => [
        name,
        poller.intervalMs || '-',
        poller.intervalMs ? `${poller.ticks} / ${poller.expectedTicks}` : '-',
        poller.p50Ms,
        poller.p95Ms,
        poller.maxMs,
        poller.commandsPerTick,
        poller.commandsPerSecond,
      ]),
  );
  const callers = table(
    ['CLUSTER NODES sent by', 'Call site', 'Per second'],
    result.clusterNodesCallers
      .filter((entry) => entry.perSecond >= 0.1)
      .map((entry) => [entry.poller, entry.caller, entry.perSecond]),
  );
  const events = Object.entries(result.webhookEvents)
    .map(([event, count]) => `${event}: ${count}`)
    .join(', ');
  const warnings = result.log.top.map((entry) => `- ${entry.count}x ${entry.message}`).join('\n');
  return [
    `### ${label(result)}`,
    '',
    commands,
    '',
    pollers,
    '',
    `The fake cluster received ${result.server.commandsPerSecond} commands/s in total; that is the number to trust. ` +
      `The per-poller numbers are counted inside the monitor and add up to ${result.clientCommandsPerSecond}/s. ` +
      'A poller is charged for everything started inside its pass, including the handshake and reconnect commands of ' +
      'a node connection it happened to open, and everything outside a poller pass is "background".',
    '',
    callers,
    '',
    `Webhook events dispatched in the window: ${events || 'none'}.`,
    `Warnings: ${result.log.warn}, errors: ${result.log.error}.`,
    warnings,
  ].join('\n');
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const workDir = cli.out ?? mkdtempSync(join(tmpdir(), 'betterdb-cluster-load-results-'));
  mkdirSync(workDir, { recursive: true });

  const results: ScenarioResult[] = [];
  const invalid: InvalidRun[] = [];
  for (const nodes of cli.nodes) {
    for (const mode of cli.modes) {
      const scenario: ScenarioOptions = {
        nodes,
        replicasPerShard: cli.replicas,
        mode,
        settleTimeoutMs: cli.settleSeconds * 1000,
        warmupMs: cli.warmupSeconds * 1000,
        measureMs: cli.measureSeconds * 1000,
        hang: cli.hang,
        failover: cli.failover,
        license: cli.license,
        profile: cli.profile,
        replyDelayMs: cli.replyDelayMs,
      };
      const problem = cli.force ? null : portProblem(nodes, mode);
      if (problem) {
        process.stderr.write(
          `Skipping ${nodes} nodes, mode ${mode}: ${problem}.\n` +
            `To run it anyway: pnpm load:cluster --nodes ${nodes} --modes ${mode} --force\n`,
        );
        invalid.push({ options: scenario, invalid: `skipped, ${problem}` });
        continue;
      }
      process.stderr.write(`Running ${nodes} nodes, mode ${mode}...\n`);
      const result = runChild(scenario, workDir);
      if (result.invalid !== undefined) invalid.push({ options: result.options, invalid: result.invalid });
      else results.push(result as ScenarioResult);
    }
  }

  const notRun = invalid.map((run) => `- ${label(run)}: ${run.invalid}`);
  const suspect = results.flatMap((result) => result.suspect.map((reason) => `- ${label(result)}: ${reason}`));
  const report = [
    summary(results),
    ...(suspect.length ? ['Suspect, read these rows with care:', suspect.join('\n')] : []),
    ...(notRun.length ? ['No numbers for:', notRun.join('\n')] : []),
    '',
    ...results.map(details),
  ].join('\n\n');
  process.stdout.write(`${report}\n`);
  if (cli.out) writeFileSync(join(workDir, 'report.md'), `${report}\n`);
}

main();
