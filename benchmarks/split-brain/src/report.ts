import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Cell, Side, TrialOutput } from './collect';
import type { ProductPin } from './product';
import { MIN_ROUNDS, PHASES, ROUND_INTERVAL_MS, STRATEGIES, type Vantage } from './replay';
import { type Interval, mean, pairedDifference, quantile, rateInterval } from './stats';

const DEFAULT_STRATEGY = 'zone-1';
const DEFAULT_ROUNDS = 3;
const AS_SHIPPED = 'as-shipped';

const STRATEGY_LABELS: Record<string, string> = {
  'random-1': 'k=1',
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
  const medians = cells.filter((cell) => cell.ttd).map((cell) => (cell.ttd as { p50: number }).p50);
  if (medians.length === 0) return '–';
  return `${seconds(quantile(medians, 0.5))} (${seconds(quantile(medians, 0.9))})`;
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
      rows.push([
        scenario,
        String(minRounds),
        medians.length ? seconds(quantile(medians, 0.5)) : '–',
        medians.length ? seconds(quantile(medians, 0.9)) : '–',
        raised ? percent(open / raised) : '–',
      ]);
    }
  }
  return table(['scenario', 'N', 'median', 'p90', 'still open when the recording ended'], rows);
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
  if (difference.identical) return 'same';
  return `${signed(difference.mean)} s [${signed(difference.low)}, ${signed(difference.high)}]${difference.tie ? ' tie' : ''}`;
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

function setupTable(results: Results, pin: ProductPin): string {
  const first = results.trials[0];
  const perScenario = results.scenarios.map((scenario) => results.of(scenario).length);
  const draws = Math.max(...STRATEGIES.map((strategy) => strategy.draws));
  return table(
    ['', ''],
    [
      ['product commit', `\`${pin.commit}\``],
      ['Valkey', first.valkey],
      ['cluster', `${first.nodes} nodes, ${first.nodes / 2} primaries and ${first.nodes / 2} replicas, 3 zones`],
      ['cluster-node-timeout', `${first.nodeTimeoutMs} ms`],
      ['scenarios', `${results.kind('fault').length} faults, ${results.kind('control').length} controls`],
      ['trials', `${results.trials.length} (${Math.min(...perScenario)}–${Math.max(...perScenario)} per scenario)`],
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
  const results = new Results(readTrials(input.trialsFile));
  const faults = results.kind('fault');
  const controls = results.kind('control');
  const text = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  const early = results.trials.reduce(
    (sum, trial) => sum + trial.cells.filter((cell) => cell.side === 'all').reduce((s, cell) => s + cell.early, 0),
    0,
  );
  const sections = [
    `# ${input.title}`,
    'Tables are generated by `pnpm bench report` from the recorded trials. The findings and limitations are written by hand from those tables.',
    text(input.findingsFile),
    '## Setup',
    setupTable(results, input.pin),
    '## How to read the tables',
    [
      '- **k=1 … k=5**: the product setting `randomNodes` with zones hidden from the detector. It is the size of the sample including the seed node, so k=1 asks no extra node unless the seed itself accuses someone.',
      '- **zone 1, zone 2**: the product setting `nodesPerZone` with `randomNodes` 3 and zones known. **zone 1 with N = 3 is what ships today.**',
      '- **all**: every node is asked every round.',
      '- **N**: rounds a disagreement must last before an event is raised (`minRounds`).',
      '- A cell such as `97% [91–100]` is the mean over trials of the share of replays that raised an event, with a 95% interval. The interval is a bootstrap over trials; when every trial gave the same answer it is the Wilson bound for that many trials.',
      '- Times are the median over trials of the per-trial median, with the 90th percentile over trials in brackets, counted from the moment the fault was injected.',
      '- Fault windows run from the injection to the heal, or to the end of the recording when the fault is never healed. Control windows run from the start of the operation to the end of the recording.',
    ].join('\n'),
    '## 1. Faults: how often an event is raised',
    'The monitor can reach every node.',
    rateTables(results, faults, {}),
    '## 2. Faults: time to the first event',
    ttdTables(results, faults),
    '## 3. Faults: monitor on the seed node\'s side of the cut',
    'Same recordings, but the monitor cannot read nodes that the seed node is cut off from. Only scenarios that cut the network are listed.',
    rateTables(results, faults, { vantage: 'inside' }),
    '## 4. Faults: does it matter which node is the seed',
    'N = 3.',
    sideTable(results, faults),
    '## 5. Controls: false positives',
    'Any event raised between the start of the operation and the end of the recording.',
    rateTables(results, controls, {}),
    '## 6. What the first event says',
    'N = 3. "Only after the window" counts replays whose first event came after the fault was healed.',
    firstEventTable(results, [...faults, ...controls]),
    '## 7. Faults: time from the heal until the events close',
    'zone 1. Replays that raised an event.',
    closeTable(results, faults),
    '## 8. Seed only: what today\'s single-view signals see',
    'These are different signals from the ones above. They read only the seed node\'s own view: the duplicate-primary detector fires on the first poll that shows two live primaries claiming the same slot, and the cluster state signal fires when the seed\'s `cluster_state` goes from ok to fail. The last column is the share of seeds that stopped answering for 3 s or more, which the product reports as a connection problem, not as a split.',
    seedOnlyTable(results),
    '## 9. Joining nodes: what is counted',
    '"as-shipped" counts every kind of disagreement with a 60 s wait on membership. "membership-only-90s" counts only membership disagreements after 90 s. "without-membership" ignores membership disagreements. Each cell is the raise rate and the time to the first event.',
    variantTable(results),
    '## 10. Cost per round',
    'N = 3. A round runs every 5 s. The seed node\'s own view is already read by the normal poll and is not counted as an extra read.',
    costTable(results),
    '## 11. Paired comparisons with what ships today',
    'Each row compares one setting with zone 1, N = 3 on the same recordings. "tie" means the 95% interval of the difference includes zero.',
    comparisonTable(results, [...faults, ...controls]),
    '## 12. Recorder timing',
    `Tick lateness is how late the recorder started a one-second tick. Host load is the 1-minute load average of the machine, sampled every five seconds while a trial was recorded; free local ports are counted the same way. Docker VM load is the 1-minute load average inside the Docker VM at the start and end of a trial. A trial is dropped and recorded again when host load or free local ports cross the limits in the README. Replays that raised an event before the fault was injected: ${early}.`,
    timingTable(results),
    text(input.limitationsFile),
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}
