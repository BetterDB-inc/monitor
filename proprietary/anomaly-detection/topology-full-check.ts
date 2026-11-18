import { createHash } from 'crypto';
import type { ClusterNode } from '@app/common/types/metrics.types';
import { compareTopologyViews, type TopologyDisagreement, type TopologyView } from './topology-divergence';
import type { FailureFlagViews } from './topology-divergence-monitor';
import {
  summarizeDisagreements,
  type DisagreementEventOf,
  type TopologyDisagreementSummary,
} from './topology-disagreements';

export const FULL_CHECK_DEFAULTS = {
  concurrency: 16,
  deadlineMs: 60_000,
  readTimeoutMs: 5_000,
  minIntervalMs: 30_000,
  keepMs: 10 * 60_000,
};

const MAX_FAILURE_REASON_LENGTH = 200;

const KEPT_FLAGS = ['master', 'slave', 'fail', 'fail?', 'handshake', 'noaddr'];
const FAILING_FLAGS = ['fail', 'fail?'];
const UNREACHABLE_FLAGS = ['handshake', 'noaddr'];

export interface FullCheckRun {
  nodes: ClusterNode[];
  readView: (node: ClusterNode, signal: AbortSignal) => Promise<ClusterNode[] | null>;
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

export interface FullCheckFailure {
  at: number;
  reason: string;
}

export type FullCheckState =
  | { state: 'none'; failure?: FullCheckFailure }
  | { state: 'running'; startedAt: number; asked: number; total: number }
  | {
      state: 'done';
      startedAt: number;
      finishedAt: number;
      asked: number;
      total: number;
      outcome: FullCheckOutcome;
      failure?: FullCheckFailure;
    };

export type FullCheckRefusal = { result: 'running' } | { result: 'too_soon'; retryAt: number };

export type FullCheckStart = { result: 'started' } | FullCheckRefusal;

export type FullCheckBlocker = 'no_direct_access' | 'ssh_tunnel' | 'raft_cluster' | 'no_cluster_view';

export const FULL_CHECK_BLOCKER_TEXT: Record<FullCheckBlocker, string> = {
  no_direct_access: 'The monitor reaches this cluster through one node only, so it cannot ask every node.',
  ssh_tunnel: 'This connection goes through an SSH tunnel, so the monitor cannot reach every node.',
  raft_cluster: 'The nodes of a Raft cluster share one agreed view, so there is nothing to compare.',
  no_cluster_view: 'No cluster view has been read on this connection yet.',
};

export interface TopologyFullCheckView {
  state: 'none' | 'running' | 'done';
  unavailable: { reason: FullCheckBlocker; text: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
  asked: number;
  total: number;
  retryAt: number | null;
  lastFailure: FullCheckFailure | null;
  summary?: TopologyDisagreementSummary;
}

export interface TopologyDisagreementReport extends TopologyDisagreementSummary {
  fullCheck: TopologyFullCheckView;
}

export type TopologyFullCheckStart =
  | FullCheckStart
  | { result: 'unavailable'; reason: FullCheckBlocker; text: string }
  | { result: 'unknown_connection' }
  | { result: 'view_unreadable' };

export function fullCheckView(
  check: FullCheckState,
  blocker: FullCheckBlocker | null,
  eventOf: DisagreementEventOf,
  minIntervalMs: number = FULL_CHECK_DEFAULTS.minIntervalMs,
): TopologyFullCheckView {
  const unavailable = blocker ? { reason: blocker, text: FULL_CHECK_BLOCKER_TEXT[blocker] } : null;
  if (check.state === 'none') {
    return {
      state: 'none',
      unavailable,
      startedAt: null,
      finishedAt: null,
      asked: 0,
      total: 0,
      retryAt: null,
      lastFailure: check.failure ?? null,
    };
  }
  if (check.state === 'running') {
    return {
      state: 'running',
      unavailable,
      startedAt: check.startedAt,
      finishedAt: null,
      asked: check.asked,
      total: check.total,
      retryAt: null,
      lastFailure: null,
    };
  }
  return {
    state: 'done',
    unavailable,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    asked: check.asked,
    total: check.total,
    retryAt: check.finishedAt + minIntervalMs,
    lastFailure: check.failure ?? null,
    summary: summarizeDisagreements(check.outcome.round, eventOf),
  };
}

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
  inFlight: Set<AbortController>,
): Promise<ClusterNode[] | null> {
  const socket = new AbortController();
  inFlight.add(socket);
  return new Promise((resolve) => {
    const timer = setTimeout(() => socket.abort(), timeoutMs);
    const settle = (view: ClusterNode[] | null) => {
      resolve(view);
      clearTimeout(timer);
      inFlight.delete(socket);
      socket.abort();
    };
    socket.signal.addEventListener('abort', () => settle(null), { once: true });
    Promise.resolve()
      .then(() => readView(node, socket.signal))
      .catch(() => null)
      .then(settle);
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
  const inFlight = new Set<AbortController>();
  let next = 0;
  let asked = 0;
  let timeIsUp = false;

  const worker = async () => {
    while (!timeIsUp && next < queue.length && input.now() - startedAt < deadlineMs) {
      const node = queue[next++];
      const reply = await readWithin(input.readView, node, readTimeoutMs, inFlight);
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
  const limit = setTimeout(() => {
    timeIsUp = true;
    for (const socket of [...inFlight]) socket.abort();
  }, deadlineMs);
  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    clearTimeout(limit);
    for (const socket of [...inFlight]) socket.abort();
  }

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
  failed?: FullCheckFailure;
}

function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_FAILURE_REASON_LENGTH);
}

export class TopologyFullChecks {
  private readonly clusters = new Map<string, ClusterCheck>();
  private tokens = 0;

  constructor(
    private readonly limits: { minIntervalMs: number; keepMs: number } = FULL_CHECK_DEFAULTS,
    private readonly now: () => number = Date.now,
  ) {}

  start(
    clusterKey: string,
    at: number,
    total: number,
    run: (onProgress: (asked: number) => void) => Promise<FullCheckOutcome>,
  ): FullCheckStart {
    const refusal = this.blocked(clusterKey, at);
    if (refusal) return refusal;
    const current = this.clusters.get(clusterKey);

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
      (error) => {
        if (!isCurrent()) return;
        entry.running = undefined;
        entry.failed = { at: this.now(), reason: failureReason(error) };
      },
    );
    return { result: 'started' };
  }

  blocked(clusterKey: string, at: number): FullCheckRefusal | null {
    const current = this.clusters.get(clusterKey);
    if (current?.running) return { result: 'running' };
    const retryAt = (current?.done?.finishedAt ?? -Infinity) + this.limits.minIntervalMs;
    return at < retryAt ? { result: 'too_soon', retryAt } : null;
  }

  state(clusterKey: string, at: number): FullCheckState {
    const entry = this.clusters.get(clusterKey);
    if (!entry) return { state: 'none' };
    if (entry.running) return { state: 'running', ...entry.running };
    if (entry.done && at - entry.done.finishedAt >= this.limits.keepMs) entry.done = undefined;
    if (entry.failed && at - entry.failed.at >= this.limits.keepMs) entry.failed = undefined;
    const outcome = entry.done;
    const failure = entry.failed ? { failure: entry.failed } : {};
    if (!outcome) {
      if (!entry.failed) this.clusters.delete(clusterKey);
      return { state: 'none', ...failure };
    }
    return {
      state: 'done',
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      asked: outcome.asked,
      total: outcome.total,
      outcome,
      ...failure,
    };
  }

  forget(clusterKey: string): void {
    this.clusters.delete(clusterKey);
  }
}
