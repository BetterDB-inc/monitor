import { createHash } from 'crypto';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { compareTopologyViews, type TopologyDisagreement, type TopologyView } from './topology-divergence';
import type { FailureFlagViews } from './topology-divergence-monitor';

export const FULL_CHECK_DEFAULTS = {
  concurrency: 16,
  deadlineMs: 60_000,
  readTimeoutMs: 5_000,
  minIntervalMs: 30_000,
  keepMs: 10 * 60_000,
};

const KEPT_FLAGS = ['master', 'slave', 'fail', 'fail?', 'handshake', 'noaddr'];
const FAILING_FLAGS = ['fail', 'fail?'];
const UNREACHABLE_FLAGS = ['handshake', 'noaddr'];

export interface FullCheckRun {
  nodes: ClusterNode[];
  readView: (node: ClusterNode) => Promise<ClusterNode[] | null>;
  now: () => number;
  concurrency?: number;
  deadlineMs?: number;
  readTimeoutMs?: number;
  onProgress?: (asked: number) => void;
}

export interface FullCheckRound {
  status: 'ok' | 'insufficient_views';
  at: number;
  observers: string[];
  unanswered: string[];
  disagreements: TopologyDisagreement[];
  nodes: Map<string, ClusterNode>;
  failureFlags: Map<string, FailureFlagViews>;
}

export interface FullCheckOutcome {
  startedAt: number;
  finishedAt: number;
  total: number;
  asked: number;
  distinctViews: number;
  round: FullCheckRound;
}

export type FullCheckState =
  | { state: 'none' }
  | { state: 'running'; startedAt: number; asked: number; total: number }
  | { state: 'done'; startedAt: number; finishedAt: number; asked: number; total: number; outcome: FullCheckOutcome };

export type FullCheckStart = { result: 'started' } | { result: 'running' } | { result: 'too_soon'; retryAt: number };

interface DistinctView {
  nodes: ClusterNode[];
  members: string[];
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function reduced(node: ClusterNode): ClusterNode {
  return {
    id: node.id,
    address: node.address,
    flags: node.flags.filter((flag) => KEPT_FLAGS.includes(flag)).sort(compareText),
    master: node.master,
    pingSent: 0,
    pongReceived: 0,
    configEpoch: node.configEpoch,
    linkState: '',
    slots: node.slots,
  };
}

function fingerprint(nodes: ClusterNode[]): string {
  const hash = createHash('sha1');
  for (const node of nodes) {
    hash.update(
      `${node.id} ${node.address.split('@')[0]} ${node.flags.join(',')} ${node.master} ${node.configEpoch} ${node.slots
        .map((range) => range.join('-'))
        .join(',')}\n`,
    );
  }
  return hash.digest('hex');
}

function isAccused(node: ClusterNode): boolean {
  return (
    node.flags.some((flag) => FAILING_FLAGS.includes(flag)) &&
    !node.flags.some((flag) => UNREACHABLE_FLAGS.includes(flag))
  );
}

function readWithin(
  readView: FullCheckRun['readView'],
  node: ClusterNode,
  timeoutMs: number,
): Promise<ClusterNode[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    Promise.resolve()
      .then(() => readView(node))
      .catch(() => null)
      .then((view) => {
        clearTimeout(timer);
        resolve(view);
      });
  });
}

function expand(
  disagreement: TopologyDisagreement,
  membersOf: Map<string, string[]>,
): TopologyDisagreement {
  const ownOpinion = disagreement.kind === 'failure_flags' ? disagreement.subjectIds[0] : undefined;
  return {
    ...disagreement,
    positions: disagreement.positions.map((position) => ({
      value: position.value,
      observers: [...new Set(position.observers.flatMap((id) => membersOf.get(id) ?? [id]))]
        .filter((id) => id !== ownOpinion)
        .sort(compareText),
    })),
  };
}

function failureFlagsOf(distinct: DistinctView[]): Map<string, FailureFlagViews> {
  const flagged = new Map<string, FailureFlagViews>();
  for (const view of distinct) {
    for (const node of view.nodes) {
      if (!isAccused(node)) continue;
      const accusers = view.members.filter((id) => id !== node.id);
      if (accusers.length === 0) continue;
      const entry = flagged.get(node.id) ?? { suspected: [], failed: [] };
      (node.flags.includes('fail') ? entry.failed : entry.suspected).push(...accusers);
      flagged.set(node.id, entry);
    }
  }
  for (const entry of flagged.values()) {
    entry.suspected.sort(compareText);
    entry.failed.sort(compareText);
  }
  return new Map([...flagged].sort((a, b) => compareText(a[0], b[0])));
}

export async function runFullCheck(input: FullCheckRun): Promise<FullCheckOutcome> {
  const concurrency = input.concurrency ?? FULL_CHECK_DEFAULTS.concurrency;
  const deadlineMs = input.deadlineMs ?? FULL_CHECK_DEFAULTS.deadlineMs;
  const readTimeoutMs = input.readTimeoutMs ?? FULL_CHECK_DEFAULTS.readTimeoutMs;
  const startedAt = input.now();
  const queue = [...input.nodes].sort((a, b) => compareText(a.id, b.id));
  const distinct = new Map<string, DistinctView>();
  const answered = new Set<string>();
  let next = 0;
  let asked = 0;

  const worker = async () => {
    while (next < queue.length && input.now() - startedAt < deadlineMs) {
      const node = queue[next++];
      const reply = await readWithin(input.readView, node, readTimeoutMs);
      asked += 1;
      if (reply?.find((entry) => entry.flags.includes('myself'))?.id === node.id) {
        const nodes = reply.map(reduced).sort((a, b) => compareText(a.id, b.id));
        const key = fingerprint(nodes);
        const same = distinct.get(key);
        if (same) same.members.push(node.id);
        else distinct.set(key, { nodes, members: [node.id] });
        answered.add(node.id);
      }
      input.onProgress?.(asked);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const groups = [...distinct.values()];
  const views: TopologyView[] = [];
  const membersOf = new Map<string, string[]>();
  for (const group of groups) {
    group.members.sort(compareText);
    for (const speaker of group.members.slice(0, 2)) {
      views.push({ observerId: speaker, nodes: group.nodes });
      membersOf.set(speaker, group.members);
    }
  }

  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  for (const group of groups) {
    for (const node of group.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
  }

  const finishedAt = input.now();
  return {
    startedAt,
    finishedAt,
    total: queue.length,
    asked,
    distinctViews: groups.length,
    round: {
      status: answered.size >= 2 ? 'ok' : 'insufficient_views',
      at: finishedAt,
      observers: queue.map((node) => node.id),
      unanswered: queue.map((node) => node.id).filter((id) => !answered.has(id)),
      disagreements: compareTopologyViews(views).map((disagreement) => expand(disagreement, membersOf)),
      nodes,
      failureFlags: failureFlagsOf(groups),
    },
  };
}

interface ClusterCheck {
  token: number;
  running?: { startedAt: number; asked: number; total: number };
  done?: FullCheckOutcome;
}

export class TopologyFullChecks {
  private readonly clusters = new Map<string, ClusterCheck>();
  private tokens = 0;

  constructor(private readonly limits: { minIntervalMs: number; keepMs: number } = FULL_CHECK_DEFAULTS) {}

  start(
    clusterKey: string,
    at: number,
    total: number,
    run: (onProgress: (asked: number) => void) => Promise<FullCheckOutcome>,
  ): FullCheckStart {
    const current = this.clusters.get(clusterKey);
    if (current?.running) return { result: 'running' };
    const retryAt = (current?.done?.finishedAt ?? -Infinity) + this.limits.minIntervalMs;
    if (at < retryAt) return { result: 'too_soon', retryAt };

    const running = { startedAt: at, asked: 0, total };
    const entry: ClusterCheck = { token: ++this.tokens, running, done: current?.done };
    this.clusters.set(clusterKey, entry);
    const isCurrent = () => this.clusters.get(clusterKey)?.token === entry.token;
    const onProgress = (asked: number) => {
      running.asked = asked;
    };
    new Promise<FullCheckOutcome>((resolve) => resolve(run(onProgress))).then(
      (outcome) => {
        if (!isCurrent()) return;
        entry.running = undefined;
        entry.done = outcome;
      },
      () => {
        if (isCurrent()) entry.running = undefined;
      },
    );
    return { result: 'started' };
  }

  state(clusterKey: string, at: number): FullCheckState {
    const entry = this.clusters.get(clusterKey);
    if (!entry) return { state: 'none' };
    if (entry.running) return { state: 'running', ...entry.running };
    const outcome = entry.done;
    if (!outcome || at - outcome.finishedAt >= this.limits.keepMs) {
      this.clusters.delete(clusterKey);
      return { state: 'none' };
    }
    return {
      state: 'done',
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      asked: outcome.asked,
      total: outcome.total,
      outcome,
    };
  }

  forget(clusterKey: string): void {
    this.clusters.delete(clusterKey);
  }
}
