import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { type Cell, SILENT_TICKS, type Side, type TrialOutput } from './collect';
import { type ProductPin, type ProductStamp, TOPOLOGY_DIVERGENCE_MAX_OBSERVERS, pinStamp } from './product';
import { MIN_RANDOM_NODES, MIN_ROUNDS, PHASES, ROUND_INTERVAL_MS, STRATEGIES, type Vantage } from './replay';
import { type Interval, countInterval, mean, medianInterval, pairedDifference, quantile, rateInterval } from './stats';

const DEFAULT_STRATEGY = 'zone-1';
const DEFAULT_ROUNDS = 3;
const AS_SHIPPED = 'as-shipped';

const STRATEGY_LABELS: Record<string, string> = {
  'random-1': 'k=1 (cannot be set)',
  'random-2': 'k=2',
  'random-3': 'k=3',
  'random-4': 'k=4',
  'random-5': 'k=5',
  'zone-1': 'zone 1',
  'zone-2': 'zone 2',
  full: 'all',
};

interface CellKey {
  strategy: string;
  minRounds: number;
  variant?: string;
  vantage?: Vantage;
  side?: Side;
}

export function readTrials(file: string): TrialOutput[] {
  return gunzipSync(readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrialOutput)
    .sort((a, b) => (a.trial < b.trial ? -1 : 1));
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function rate(interval: Interval): string {
  return `${percent(interval.mean)} [${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}]`;
}

function signed(value: number, digits = 1): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
}

class Results {
  readonly scenarios: string[];
  private readonly byScenario = new Map<string, TrialOutput[]>();

  constructor(readonly trials: TrialOutput[]) {
    for (const trial of trials) {
      const list = this.byScenario.get(trial.scenario) ?? [];
      list.push(trial);
      this.byScenario.set(trial.scenario, list);
    }
    this.scenarios = [...this.byScenario.keys()];
  }

  of(scenario: string): TrialOutput[] {
    return this.byScenario.get(scenario) ?? [];
  }

  kind(kind: 'fault' | 'control'): string[] {
    return this.scenarios.filter((scenario) => this.of(scenario)[0].kind === kind);
  }

  cells(scenario: string, key: CellKey): Cell[] {
    const wanted = { variant: AS_SHIPPED, vantage: 'outside' as Vantage, side: 'all' as Side, ...key };
    return this.of(scenario).flatMap((trial) =>
      trial.cells.filter(
        (cell) =>
          cell.strategy === wanted.strategy &&
          cell.minRounds === wanted.minRounds &&
          cell.variant === wanted.variant &&
          cell.vantage === wanted.vantage &&
          cell.side === wanted.side,
      ),
    );
  }

  shares(scenario: string, key: CellKey): number[] {
    return this.cells(scenario, key).map((cell) => cell.raised / cell.replays);
  }

  has(scenario: string, key: CellKey): boolean {
    return this.cells(scenario, key).length > 0;
  }
}

function ttdCell(cells: Cell[]): string {
  if (cells.length === 0) return '–';
  const medians = cells.filter((cell) => cell.ttd).map((cell) => (cell.ttd as { p50: number }).p50);
  const never = `never ${cells.length - medians.length}/${cells.length}`;
  if (medians.length === 0) return never;
  const interval = medianInterval(medians);
  return `${seconds(interval.mean)} [${seconds(interval.low)}–${seconds(interval.high)}], p90 ${seconds(quantile(medians, 0.9))}, ${never}`;
}

function controlTables(results: Results, scenarios: string[]): string {
  return MIN_ROUNDS.map((minRounds) => {
    const rows = scenarios.map((scenario) => [
      scenario,
      ...STRATEGIES.map((strategy) => {
        const shares = results.shares(scenario, { strategy: strategy.name, minRounds });
        const raising = shares.filter((share) => share > 0).length;
        const interval = countInterval(raising, shares.length);
        return `${raising}/${shares.length} [${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}], ${percent(mean(shares))} of replays`;
      }),
    ]);
    return `**N = ${minRounds}**\n\n${table(['scenario', ...STRATEGIES.map((s) => STRATEGY_LABELS[s.name])], rows)}`;
  }).join('\n\n');
}

function shownTable(results: Results): string {
  const rows = results.scenarios.map((scenario) => {
    const trials = results.of(scenario);
    const count = (test: (trial: TrialOutput) => boolean) => `${trials.filter(test).length}/${trials.length}`;
    const runs = trials.map((trial) => trial.shown.longestSplitTicks);
    return [
      scenario,
      trials[0].kind,
      count((trial) => trial.shown.flagged > 0 || trial.shown.unanswered > 0),
      count((trial) => trial.shown.split > 0),
      `${quantile(runs, 0.5)} / ${Math.max(...runs)}`,
      ...MIN_ROUNDS.map((minRounds) => count((trial) => trial.shown.splitRounds >= minRounds)),
    ];
  });
  return table(
    [
      'scenario',
      'kind',
      'a failure flag or a silent node was seen',
      'two nodes disagreed at some sample',
      'most samples in a row that disagreed, median / max over trials',
      ...MIN_ROUNDS.map((minRounds) => `disagreed at ${minRounds} rounds in a row`),
    ],
    rows,
  );
}

function raisedWithoutRounds(results: Results): string {
  return MIN_ROUNDS.map((minRounds) => {
    const trials = results.trials.filter(
      (trial) =>
        trial.shown.splitRounds < minRounds &&
        trial.cells.some((cell) => cell.minRounds === minRounds && cell.raised > 0),
    );
    return `${trials.length} at N = ${minRounds}`;
  }).join(', ');
}

export function assertOneConfiguration(trials: TrialOutput[]): void {
  const found = new Set(
    trials.map((trial) => `${trial.nodes} nodes, node timeout ${trial.nodeTimeoutMs} ms, Valkey ${trial.valkey}`),
  );
  if (found.size > 1) {
    throw new Error(`the trials mix configurations (${[...found].sort().join('; ')}); report each one on its own`);
  }
}

export function replayedProduct(trials: TrialOutput[], pin: ProductPin): ProductStamp {
  const again = 'run `bench replay` again';
  if (trials.some((trial) => !trial.product)) {
    throw new Error(`the trials do not say which product commit they were replayed at; ${again}`);
  }
  const found = new Map(trials.map((trial) => [`${trial.product.commit} ${trial.product.files}`, trial.product]));
  if (found.size > 1) {
    const commits = [...found.values()].map((stamp) => stamp.commit).sort().join(', ');
    throw new Error(`the trials were replayed at more than one product pin (${commits}); ${again}`);
  }
  const [stamp] = found.values();
  if (stamp.files !== pinStamp(pin).files) {
    throw new Error(`the trials were replayed at product commit ${stamp.commit} and the pin is now ${pin.commit}; ${again}`);
  }
  return stamp;
}

function controlViewsTable(results: Results, scenarios: string[]): string {
  const rows = scenarios.map((scenario) => {
    const trials = results.of(scenario);
    const differed = trials.filter((trial) => trial.shown.split > 0);
    const raised = trials.filter((trial) => trial.cells.some((cell) => cell.raised > 0));
    const identical = raised.filter((trial) => trial.shown.split === 0);
    return [
      scenario,
      `${differed.length}/${trials.length}`,
      `${raised.length}/${trials.length}`,
      `${raised.length - identical.length}`,
      `${identical.length}`,
    ];
  });
  return table(
    [
      'scenario',
      'trials with any view difference',
      'trials with an event at any setting',
      'of those, with a view difference',
      'of those, with identical views',
    ],
    rows,
  );
}

function droppedTable(results: Results): string {
  const rows = results.scenarios.map((scenario) => {
    const trials = results.of(scenario);
    const reasons = new Map<string, number>();
    for (const trial of trials) {
      for (const reason of trial.dropped) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return [
      scenario,
      String(trials.length),
      String(trials.filter((trial) => trial.attempt > 1).length),
      String(trials.reduce((sum, trial) => sum + trial.dropped.length, 0)),
      String(trials.filter((trial) => !trial.lateOk).length),
      [...reasons.entries()].map(([reason, count]) => `${count}× ${reason}`).join('; ') || '–',
    ];
  });
  return table(
    ['scenario', 'trials kept', 'kept after a dropped attempt', 'attempts dropped', 'kept with p99 lateness over 250 ms', 'why attempts were dropped'],
    rows,
  );
}

function rateTables(results: Results, scenarios: string[], key: Omit<CellKey, 'strategy' | 'minRounds'>): string {
  const usable = scenarios.filter((scenario) =>
    results.has(scenario, { strategy: DEFAULT_STRATEGY, minRounds: DEFAULT_ROUNDS, ...key }),
  );
  return MIN_ROUNDS.map((minRounds) => {
    const rows = usable.map((scenario) => [
      scenario,
      ...STRATEGIES.map((strategy) => rate(rateInterval(results.shares(scenario, { strategy: strategy.name, minRounds, ...key })))),
    ]);
    return `**N = ${minRounds}**\n\n${table(['scenario', ...STRATEGIES.map((s) => STRATEGY_LABELS[s.name])], rows)}`;
  }).join('\n\n');
}

function ttdTables(results: Results, scenarios: string[]): string {
  return MIN_ROUNDS.map((minRounds) => {
    const rows = scenarios.map((scenario) => [
      scenario,
      ...STRATEGIES.map((strategy) => ttdCell(results.cells(scenario, { strategy: strategy.name, minRounds }))),
    ]);
    return `**N = ${minRounds}**\n\n${table(['scenario', ...STRATEGIES.map((s) => STRATEGY_LABELS[s.name])], rows)}`;
  }).join('\n\n');
}

function sideTable(results: Results, scenarios: string[]): string {
  const rows: string[][] = [];
  for (const scenario of scenarios) {
    for (const strategy of [DEFAULT_STRATEGY, 'full']) {
      for (const vantage of ['outside', 'inside'] as Vantage[]) {
        const key = { strategy, minRounds: DEFAULT_ROUNDS, vantage };
        if (!results.has(scenario, { ...key, side: 'faulted' })) continue;
        rows.push([
          scenario,
          STRATEGY_LABELS[strategy],
          vantage,
          rate(rateInterval(results.shares(scenario, { ...key, side: 'faulted' }))),
          rate(rateInterval(results.shares(scenario, { ...key, side: 'healthy' }))),
        ]);
      }
    }
  }
  return table(['scenario', 'coverage', 'monitor', 'seed is a faulted node', 'seed is a healthy node'], rows);
}

function firstEventTable(results: Results, scenarios: string[]): string {
  const rows: string[][] = [];
  for (const scenario of scenarios) {
    for (const strategy of [DEFAULT_STRATEGY, 'full']) {
      const cells = results.cells(scenario, { strategy, minRounds: DEFAULT_ROUNDS });
      const total = (pick: (cell: Cell) => number) => cells.reduce((sum, cell) => sum + pick(cell), 0);
      const raised = total((cell) => cell.raised);
      const replays = total((cell) => cell.replays);
      const kinds = new Map<string, number>();
      for (const cell of cells) {
        for (const [kind, count] of Object.entries(cell.kinds)) kinds.set(kind, (kinds.get(kind) ?? 0) + count);
      }
      const blamed = total((cell) => cell.blame.faulted + cell.blame.healthy + cell.blame.mixed);
      const share = (count: number, of: number) => (of === 0 ? '–' : percent(count / of));
      rows.push([
        scenario,
        STRATEGY_LABELS[strategy],
        share(raised, replays),
        share(total((cell) => cell.critical), raised),
        share(total((cell) => cell.late), replays),
        share(total((cell) => cell.blame.faulted), blamed),
        [...kinds.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([kind, count]) => `${kind.replace(/_/g, ' ')} ${share(count, raised)}`)
          .join(', ') || '–',
      ]);
    }
  }
  return table(
    ['scenario', 'coverage', 'raised', 'critical (of raised)', 'only after the window', 'dissenters all on the faulted side', 'what the first event disputes'],
    rows,
  );
}

function closeTable(results: Results, scenarios: string[]): string {
  const rows: string[][] = [];
  for (const scenario of scenarios) {
    if (!results.of(scenario)[0].healed) continue;
    for (const minRounds of MIN_ROUNDS) {
      const cells = results.cells(scenario, { strategy: DEFAULT_STRATEGY, minRounds });
      const medians = cells.filter((cell) => cell.closed).map((cell) => (cell.closed as { p50: number }).p50);
      const raised = cells.reduce((sum, cell) => sum + cell.raised, 0);
      const open = cells.reduce((sum, cell) => sum + cell.stillOpen, 0);
      const before = cells.reduce((sum, cell) => sum + cell.closedBeforeHeal, 0);
      rows.push([
        scenario,
        String(minRounds),
        medians.length ? seconds(quantile(medians, 0.5)) : '–',
        medians.length ? seconds(quantile(medians, 0.9)) : '–',
        raised ? percent(before / raised) : '–',
        raised ? percent(open / raised) : '–',
      ]);
    }
  }
  return table(
    ['scenario', 'N', 'median', 'p90', 'closed before the heal', 'still open when the recording ended'],
    rows,
  );
}

function seedOnlyTable(results: Results): string {
  const rows = results.scenarios.map((scenario) => {
    const cells = results.of(scenario).map((trial) => trial.seedOnly.find((cell) => cell.side === 'all')!);
    const share = (pick: (cell: (typeof cells)[number]) => number) =>
      rate(rateInterval(cells.map((cell) => pick(cell) / cell.seeds)));
    const ttd = (pick: (cell: (typeof cells)[number]) => { p50: number } | null) => {
      const medians = cells.map(pick).filter((value): value is { p50: number } => value !== null).map((value) => value.p50);
      return medians.length ? seconds(quantile(medians, 0.5)) : '–';
    };
    return [
      scenario,
      results.of(scenario)[0].kind,
      share((cell) => cell.duplicatePrimary),
      ttd((cell) => cell.duplicatePrimaryTtd),
      share((cell) => cell.clusterStateFail),
      ttd((cell) => cell.clusterStateFailTtd),
      share((cell) => cell.silent),
    ];
  });
  return table(
    ['scenario', 'kind', 'two primaries for one slot', 'after', 'cluster state turns fail', 'after', 'seed stops answering'],
    rows,
  );
}

function variantTable(results: Results): string {
  const scenarios = results.scenarios.filter((scenario) => scenario.includes('join'));
  const variants = [AS_SHIPPED, 'membership-only-90s', 'without-membership'];
  const rows: string[][] = [];
  for (const scenario of scenarios) {
    for (const strategy of [DEFAULT_STRATEGY, 'full']) {
      for (const variant of variants) {
        rows.push([
          scenario,
          STRATEGY_LABELS[strategy],
          variant,
          ...MIN_ROUNDS.map((minRounds) => {
            const key = { strategy, minRounds, variant };
            return `${rate(rateInterval(results.shares(scenario, key)))} · ${ttdCell(results.cells(scenario, key))}`;
          }),
        ]);
      }
    }
  }
  return table(['scenario', 'coverage', 'what is counted', ...MIN_ROUNDS.map((n) => `N = ${n}`)], rows);
}

function costTable(results: Results): string {
  const perRound = (scenarios: string[], strategy: string, pick: (cell: Cell) => number) => {
    const cells = scenarios.flatMap((scenario) => results.cells(scenario, { strategy, minRounds: DEFAULT_ROUNDS }));
    const rounds = cells.reduce((sum, cell) => sum + cell.rounds, 0);
    return rounds === 0 ? 0 : cells.reduce((sum, cell) => sum + pick(cell), 0) / rounds;
  };
  const faults = results.kind('fault');
  const rows = STRATEGIES.map((strategy) => {
    const idleReads = perRound(['idle'], strategy.name, (cell) => cell.reads);
    return [
      STRATEGY_LABELS[strategy.name],
      perRound(['idle'], strategy.name, (cell) => cell.views).toFixed(2),
      idleReads.toFixed(2),
      `${(perRound(['idle'], strategy.name, (cell) => cell.bytes) / 1024).toFixed(1)} KB`,
      `${((idleReads * 60_000) / ROUND_INTERVAL_MS).toFixed(0)}`,
      perRound(faults, strategy.name, (cell) => cell.views).toFixed(2),
      perRound(faults, strategy.name, (cell) => cell.reads).toFixed(2),
      perRound(faults, strategy.name, (cell) => cell.migrationChecks).toFixed(3),
    ];
  });
  return table(
    [
      'coverage',
      'views compared per round (idle)',
      'extra CLUSTER NODES reads per round (idle)',
      'reply bytes per round (idle)',
      'extra reads per minute (idle)',
      'views per round (faults)',
      'extra reads per round (faults)',
      'migration checks per round (faults)',
    ],
    rows,
  );
}

function ttdDifference(a: Cell[], b: Cell[]): string {
  const pairs = a
    .map((cell, index) => [cell.ttd?.p50, b[index]?.ttd?.p50] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  if (pairs.length < 5) return '–';
  const difference = pairedDifference(
    pairs.map((pair) => pair[0] / 1000),
    pairs.map((pair) => pair[1] / 1000),
  );
  if (difference.identical) return `same (${pairs.length} trials)`;
  return `${signed(difference.mean)} s [${signed(difference.low)}, ${signed(difference.high)}]${difference.tie ? ' tie' : ''} (${pairs.length} trials)`;
}

function comparisonTable(results: Results, scenarios: string[]): string {
  const base = { strategy: DEFAULT_STRATEGY, minRounds: DEFAULT_ROUNDS };
  const others: Array<{ label: string; key: CellKey }> = [
    ...STRATEGIES.filter((strategy) => strategy.name !== DEFAULT_STRATEGY).map((strategy) => ({
      label: `${STRATEGY_LABELS[strategy.name]}, N=3`,
      key: { strategy: strategy.name, minRounds: DEFAULT_ROUNDS },
    })),
    ...MIN_ROUNDS.filter((n) => n !== DEFAULT_ROUNDS).map((minRounds) => ({
      label: `zone 1, N=${minRounds}`,
      key: { strategy: DEFAULT_STRATEGY, minRounds },
    })),
  ];
  const rows: string[][] = [];
  for (const scenario of scenarios) {
    const baseShares = results.shares(scenario, base);
    const baseCells = results.cells(scenario, base);
    for (const other of others) {
      const difference = pairedDifference(results.shares(scenario, other.key), baseShares);
      const verdict = difference.identical ? 'same in every trial' : difference.tie ? 'tie' : difference.mean > 0 ? 'higher' : 'lower';
      rows.push([
        scenario,
        other.label,
        difference.identical
          ? '0'
          : `${signed(difference.mean * 100)} pp [${signed(difference.low * 100)}, ${signed(difference.high * 100)}]`,
        verdict,
        ttdDifference(results.cells(scenario, other.key), baseCells),
      ]);
    }
  }
  return table(['scenario', 'compared with zone 1, N=3', 'raise rate difference', 'verdict', 'time to first event difference'], rows);
}

function timingTable(results: Results): string {
  const lanes = [...new Set(results.trials.map((trial) => trial.lane))].sort();
  const rows = lanes.map((lane) => {
    const trials = results.trials.filter((trial) => trial.lane === lane);
    return [
      String(lane),
      String(trials.length),
      `${quantile(trials.map((trial) => trial.late.p50), 0.5)} ms`,
      `${quantile(trials.map((trial) => trial.late.p99), 0.5)} ms`,
      `${Math.max(...trials.map((trial) => trial.late.p99))} ms`,
      `${Math.max(...trials.map((trial) => trial.late.max))} ms`,
      mean(trials.map((trial) => trial.host?.load.start ?? 0)).toFixed(1),
      Math.max(...trials.map((trial) => trial.host?.load.max ?? 0)).toFixed(1),
      String(Math.min(...trials.map((trial) => trial.host?.freePorts.min ?? 0))),
      Math.max(...trials.map((trial) => Math.max(trial.host?.vmLoad.start ?? 0, trial.host?.vmLoad.end ?? 0))).toFixed(1),
    ];
  });
  return table(
    ['lane', 'trials', 'median tick lateness', 'median p99 lateness', 'worst p99 lateness', 'worst single tick', 'mean host load', 'worst host load', 'fewest free local ports', 'worst Docker VM load'],
    rows,
  );
}

function setupTable(results: Results, product: ProductStamp): string {
  const first = results.trials[0];
  const perScenario = results.scenarios.map((scenario) => results.of(scenario).length);
  const draws = Math.max(...STRATEGIES.map((strategy) => strategy.draws));
  return table(
    ['', ''],
    [
      ['product commit', `\`${product.commit}\``],
      ['Valkey', first.valkey],
      ['cluster', `${first.nodes} nodes, ${first.nodes / 2} primaries and ${first.nodes / 2} replicas, 3 zones`],
      ['cluster-node-timeout', `${first.nodeTimeoutMs} ms`],
      ['scenarios', `${results.kind('fault').length} faults, ${results.kind('control').length} controls`],
      ['trials', `${results.trials.length} (${[...new Set([Math.min(...perScenario), Math.max(...perScenario)])].join('–')} per scenario)`],
      ['recording', 'every node asked once a second for CLUSTER NODES, CLUSTER INFO and CLUSTER GETSLOTMIGRATIONS'],
      ['round interval', `${ROUND_INTERVAL_MS / 1000} s`],
      [
        'replays per trial and setting',
        `${first.nodes} seed nodes × ${PHASES} round phases × up to ${draws} random draws = up to ${first.nodes * PHASES * draws}`,
      ],
    ],
  );
}

export function buildReport(input: {
  title: string;
  trialsFile: string;
  pin: ProductPin;
  findingsFile: string;
  limitationsFile: string;
}): string {
  const trials = readTrials(input.trialsFile);
  assertOneConfiguration(trials);
  const product = replayedProduct(trials, input.pin);
  const results = new Results(trials);
  const observers = results.trials[0].nodes - 1;
  const faults = results.kind('fault');
  const controls = results.kind('control');
  const text = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  const early = results.trials.filter((trial) =>
    trial.cells.some(
      (cell) =>
        cell.strategy === DEFAULT_STRATEGY &&
        cell.minRounds === DEFAULT_ROUNDS &&
        cell.variant === AS_SHIPPED &&
        cell.vantage === 'outside' &&
        cell.side === 'all' &&
        cell.early > 0,
    ),
  ).length;
  const sections = [
    `# ${input.title}`,
    'Tables are generated by `pnpm bench report` from the recorded trials. The findings and limitations are written by hand from those tables.',
    text(input.findingsFile),
    '## Setup',
    setupTable(results, product),
    '## How to read the tables',
    [
      '- **k=1 … k=5**: the product setting `randomNodes` with zones hidden from the detector. It is the size of the sample including the seed node, so k=1 asks no extra node unless the seed itself accuses someone.',
      `- **k=1 cannot be set in the product.** \`ANOMALY_TOPOLOGY_DIVERGENCE_RANDOM_NODES\` accepts ${MIN_RANDOM_NODES} or more and the service raises a lower value to ${MIN_RANDOM_NODES}. k=1 is in the tables as the lower bound of coverage, not as a setting to choose; k=${MIN_RANDOM_NODES} is the smallest sample a user can set.`,
      '- **zone 1, zone 2**: the product setting `nodesPerZone` with `randomNodes` 3 and zones known. **zone 1 with N = 3 is what ships today.**',
      `- **all**: every node is asked every round, up to the detector's limit of ${TOPOLOGY_DIVERGENCE_MAX_OBSERVERS} observers per round. ${observers > TOPOLOGY_DIVERGENCE_MAX_OBSERVERS ? `With ${observers} other nodes the limit is reached, so "all" is a sample of ${TOPOLOGY_DIVERGENCE_MAX_OBSERVERS}.` : `With ${observers} other nodes the limit is not reached.`}`,
      '- **N**: rounds a disagreement must last before an event is raised (`minRounds`).',
      '- A cell such as `97% [91–100]` is the mean over trials of the share of replays that raised an event, with a 95% interval. The interval is a bootstrap over trials, widened for rare outcomes: the upper end is at least the Wilson upper bound for the number of trials in which any replay raised, multiplied by the mean share of replays that raised in those trials, and the lower end is the mirror image for the trials in which any replay missed. When no trial raised at all the interval is the plain Wilson interval for 0 of n, so none of 30 gives [0–11]; when every replay of every trial raised it is the plain Wilson interval for n of n, so 30 of 30 gives [89–100]. When every trial raised in part, as in a cell such as `57% [54–60]`, the bootstrap decides.',
      '- In the control tables a cell such as `1/30 [1–17], 0% of replays` is the number of trials in which at least one replay raised an event, with its Wilson interval, then the share of all replays that raised.',
      '- A time such as `12 s [11 s–14 s], p90 16 s, never 3/30` is the median over trials of the per-trial median, with a bootstrap 95% interval of that median, the 90th percentile over trials, and the number of trials in which no replay raised an event. Trials that never raised are not in the time. Times are counted from the moment the fault was injected.',
      '- Fault windows run from the injection to the heal, or to the end of the recording when the fault is never healed. Control windows run from the start of the operation to the end of the recording.',
    ].join('\n'),
    '## 1. Faults: how often an event is raised',
    'The monitor can reach every node. Killed primary and paused node are listed as faults in the issue, but they end with every reachable node agreeing that the node failed. Agreement is the expected end state there, so a low rate in those two rows is not a missed split.',
    rateTables(results, faults, {}),
    '## 2. Did the fault show in the nodes\' views',
    `Read straight from the recordings, without the detector. Inside the window of each trial: whether any node showed a failure flag or stopped answering, whether the views of two answering nodes differed at the same sample (flags, primary, config epoch or slots), and the most samples in a row that differed. Samples are 1 s apart, so n samples in a row mean the difference was seen over n − 1 s. A run that starts and ends inside the window lasted less than n + 1 s; a run that reaches the first or the last sample of the window can have lasted longer. That run does not decide an event: an event at N needs a disagreement at N detector rounds in a row, and rounds are ${ROUND_INTERVAL_MS / 1000} s apart, so two rounds can both land on a difference with agreement between them. The last columns therefore count rounds: the trials in which, for at least one seed node and round phase, the views of the answering nodes differed at N of that seed's rounds in a row, with the rounds placed as the replay places them. They describe the recordings and are not a limit on what a setting can raise; section 1 is the measurement. Trials in which some setting raised an event at N without N such rounds in a row: ${raisedWithoutRounds(results)}.`,
    shownTable(results),
    '## 3. Faults: time to the first event',
    ttdTables(results, faults),
    '## 4. Faults: monitor on the seed node\'s side of the cut',
    'Same recordings, but the monitor cannot read nodes that the seed node is cut off from. Only scenarios that cut the network are listed.',
    rateTables(results, faults, { vantage: 'inside' }),
    '## 5. Faults: does it matter which node is the seed',
    'N = 3.',
    sideTable(results, faults),
    '## 6. Controls: false positives',
    'Any event raised between the start of the operation and the end of the recording.',
    controlTables(results, controls),
    'Views and events side by side. A view difference means the views of two answering nodes differed at some sampled second (flags, primary, config epoch or slots, read once a second without the detector). "At any setting" covers every coverage, every N and, for the clean join, every join variant. Controls cut no link, so they are replayed with the monitor outside only. An event in a trial with identical views did not come from a disagreement the one-second samples could see.',
    controlViewsTable(results, controls),
    '## 7. What the first event says',
    'N = 3. "Only after the window" counts replays whose first event came after the fault was healed.',
    firstEventTable(results, [...faults, ...controls]),
    '## 8. Faults: time from the heal until the events close',
    'zone 1. Replays that raised an event inside the fault window. The time runs from the heal to the moment the events raised in the window are closed, together with any event raised while one of them was still open, because the cluster can regroup a dispute into a new event while it heals. An event that replaced an earlier one with a higher severity counts as the same event. Events raised before the window, or after those events closed, are not counted. Replays whose events all closed before the heal are counted in their own column and are not in the times.',
    closeTable(results, faults),
    '## 9. Seed only: what today\'s single-view signals see',
    'These are different signals from the ones above. They read only the seed node\'s own view: the duplicate-primary detector fires on the first poll that shows two live primaries claiming the same slot, and the cluster state signal fires when the seed\'s `cluster_state` goes from ok to fail. The last column is the share of seeds that did not answer ' +
      `${SILENT_TICKS} or more samples in a row, which the product reports as a connection problem, not as a split.`,
    seedOnlyTable(results),
    '## 10. Joining nodes: what is counted',
    '"as-shipped" counts every kind of disagreement with a 60 s wait on membership. "membership-only-90s" counts only membership disagreements after 90 s. "without-membership" ignores membership disagreements. Each cell is the raise rate and the time to the first event.',
    variantTable(results),
    '## 11. Cost per round',
    'N = 3. A round runs every 5 s. The seed node\'s own view is already read by the normal poll and is not counted as an extra read.',
    costTable(results),
    '## 12. Paired comparisons with what ships today',
    'Each row compares one setting with zone 1, N = 3 on the same recordings. "tie" means the 95% interval of the difference includes zero. The time difference uses only the trials in which both settings raised an event; their number is in brackets.',
    comparisonTable(results, [...faults, ...controls]),
    '## 13. Recording quality',
    `Tick lateness is how late the recorder started a one-second tick; replay uses the planned tick times. Host load is the 1-minute load average of the machine, sampled every five seconds while a trial was recorded; free local ports are counted the same way. Docker VM load is the 1-minute load average inside the Docker VM at the start and end of a trial. Trials in which the shipped setting raised an event before the injection: ${early} of ${results.trials.length}.`,
    timingTable(results),
    'An attempt is dropped and the trial recorded again when the cluster does not build, an injection fails, or host load or free local ports cross the limits in the README.',
    droppedTable(results),
    text(input.limitationsFile),
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}
