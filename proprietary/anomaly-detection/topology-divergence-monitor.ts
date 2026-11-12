import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  DivergenceTracker,
  type TopologyView,
  type TrackedDisagreement,
  compareTopologyViews,
} from './topology-divergence';
import { selectObservers } from './topology-observers';

export const TOPOLOGY_DIVERGENCE_DEFAULTS = {
  nodesPerZone: 1,
  randomNodes: 3,
  minRounds: 3,
  intervalMs: 5_000,
};
export const TOPOLOGY_DIVERGENCE_NODE_TIMEOUT_FALLBACK_MS = 15_000;
export const TOPOLOGY_DIVERGENCE_NODE_TIMEOUT_REFRESH_MS = 5 * 60_000;
export const TOPOLOGY_DIVERGENCE_MEMBERSHIP_MIN_AGE_MS = 60_000;
export const TOPOLOGY_DIVERGENCE_MAX_MIGRATION_CHECKS = 3;
export const TOPOLOGY_DIVERGENCE_MAX_OBSERVERS = 12;
export const TOPOLOGY_DIVERGENCE_MAX_ACCUSED = 2;
export const TOPOLOGY_DIVERGENCE_IDLE_ROUNDS = 3;
export const TOPOLOGY_DIVERGENCE_BACKOFF_MAX_ROUNDS = 8;

const FAILING_FLAGS = ['fail', 'fail?'];
const UNREACHABLE_FLAGS = ['handshake', 'noaddr'];

export interface DivergencePoll {
  clusterKey: string;
  connectionId: string;
  nodes: ClusterNode[];
  at: number;
  intervalMs: number;
  nodesPerZone: number;
  randomNodes: number;
  canRead: boolean;
  readView: (node: ClusterNode) => Promise<ClusterNode[] | null>;
}

export interface DivergenceRoundResult {
  clusterKey: string;
  anchorConnectionId: string;
  at: number;
  status: 'ok' | 'insufficient_views';
  observers: string[];
  unanswered: string[];
  disagreements: TrackedDisagreement[];
  nodes: Map<string, ClusterNode>;
  selves: Map<string, ClusterNode>;
}

interface ReadBackoff {
  failures: number;
  retryAt: number;
}

interface ClusterRounds {
  anchor?: string;
  anchorSeenAt: number;
  lastRoundAt: number;
  lastBlindRoundAt: number;
  running: boolean;
  members: Map<string, { nodeId: string; seenAt: number }>;
  offered: Map<string, { nodes: ClusterNode[]; at: number }>;
  sampled: string[];
  observers: Set<string>;
  unanswered: Set<string>;
  accused: string[];
  backoff: Map<string, ReadBackoff>;
  tracker: DivergenceTracker;
  last?: DivergenceRoundResult;
}

function myselfOf(nodes: ClusterNode[]): ClusterNode | undefined {
  return nodes.find((node) => node.flags.includes('myself'));
}

function isAccused(node: ClusterNode): boolean {
  return (
    node.flags.some((flag) => FAILING_FLAGS.includes(flag)) &&
    !node.flags.some((flag) => UNREACHABLE_FLAGS.includes(flag))
  );
}

export class TopologyDivergenceMonitor {
  private readonly clusters = new Map<string, ClusterRounds>();

  constructor(private readonly random: () => number = Math.random) {}

  async poll(input: DivergencePoll): Promise<DivergenceRoundResult | null> {
    const self = myselfOf(input.nodes);
    if (!self) return null;

    const state = this.stateOf(input.clusterKey);
    const idleMs = TOPOLOGY_DIVERGENCE_IDLE_ROUNDS * input.intervalMs;
    state.members.set(input.connectionId, { nodeId: self.id, seenAt: input.at });
    if (!input.canRead && state.anchor === input.connectionId) state.anchor = undefined;

    const anchorIdle = input.at - state.anchorSeenAt > idleMs;
    if (state.anchor && state.anchor !== input.connectionId && !anchorIdle) {
      if (state.observers.has(self.id)) state.offered.set(self.id, { nodes: input.nodes, at: input.at });
      return null;
    }
    if (!input.canRead) return this.blindRound(state, input, self);
    state.anchor = input.connectionId;
    state.anchorSeenAt = input.at;
    if (state.running || input.at - state.lastRoundAt < input.intervalMs) return null;

    state.running = true;
    try {
      state.lastRoundAt = input.at;
      state.last = await this.runRound(state, input, self, idleMs);
      return state.last;
    } finally {
      state.running = false;
    }
  }

  lastRound(clusterKey: string): DivergenceRoundResult | undefined {
    return this.clusters.get(clusterKey)?.last;
  }

  anchorOf(clusterKey: string): string | undefined {
    return this.clusters.get(clusterKey)?.anchor;
  }

  restart(clusterKey: string, key: string): void {
    this.clusters.get(clusterKey)?.tracker.restart(key);
  }

  forgetConnection(connectionId: string): void {
    for (const [clusterKey, state] of this.clusters) {
      if (!state.members.delete(connectionId) && state.anchor !== connectionId) continue;
      if (state.anchor === connectionId) state.anchor = undefined;
      if (state.members.size === 0) this.clusters.delete(clusterKey);
    }
  }

  forgetCluster(clusterKey: string): void {
    this.clusters.delete(clusterKey);
  }

  private stateOf(clusterKey: string): ClusterRounds {
    let state = this.clusters.get(clusterKey);
    if (!state) {
      state = {
        anchorSeenAt: -Infinity,
        lastRoundAt: -Infinity,
        lastBlindRoundAt: -Infinity,
        running: false,
        members: new Map(),
        offered: new Map(),
        sampled: [],
        observers: new Set(),
        unanswered: new Set(),
        accused: [],
        backoff: new Map(),
        tracker: new DivergenceTracker(),
      };
      this.clusters.set(clusterKey, state);
    }
    return state;
  }

  private blindRound(state: ClusterRounds, input: DivergencePoll, self: ClusterNode): DivergenceRoundResult | null {
    if (state.running || input.at - state.lastBlindRoundAt < input.intervalMs) return null;
    state.lastBlindRoundAt = input.at;
    state.tracker.observe({ at: input.at, disagreements: [], unanswered: [], views: 1 });
    state.last = {
      clusterKey: input.clusterKey,
      anchorConnectionId: input.connectionId,
      at: input.at,
      status: 'insufficient_views',
      observers: [self.id],
      unanswered: [],
      disagreements: state.tracker.tracked(),
      nodes: new Map(input.nodes.map((node) => [node.id, node])),
      selves: new Map([[self.id, self]]),
    };
    return state.last;
  }

  private async runRound(
    state: ClusterRounds,
    input: DivergencePoll,
    self: ClusterNode,
    idleMs: number,
  ): Promise<DivergenceRoundResult> {
    const { at } = input;
    const registered = new Set<string>();
    for (const [connectionId, member] of state.members) {
      if (at - member.seenAt > idleMs) state.members.delete(connectionId);
      else if (connectionId !== input.connectionId) registered.add(member.nodeId);
    }

    const tracked = state.tracker.tracked();
    const frozen = new Set(tracked.flatMap((entry) => entry.positions.flatMap((position) => position.observers)));
    const selection = selectObservers({
      nodes: input.nodes,
      anchorId: self.id,
      registeredIds: registered,
      previous: state.sampled,
      unanswered: state.unanswered,
      frozen,
      accused: state.accused.filter((id) => !this.backingOff(state, id, at)),
      nodesPerZone: input.nodesPerZone,
      randomNodes: input.randomNodes,
      maxObservers: TOPOLOGY_DIVERGENCE_MAX_OBSERVERS,
      maxAccused: TOPOLOGY_DIVERGENCE_MAX_ACCUSED,
      random: this.random,
    });
    state.sampled = selection.sampled;
    state.observers = new Set(selection.observers);
    const offered = state.offered;
    state.offered = new Map();

    const byId = new Map(input.nodes.map((node) => [node.id, node]));
    const views: TopologyView[] = [{ observerId: self.id, nodes: input.nodes }];
    const unanswered = new Set<string>();
    const reads: ClusterNode[] = [];
    for (const id of selection.observers) {
      if (id === self.id) continue;
      const offer = registered.has(id) ? offered.get(id) : undefined;
      if (offer && at - offer.at <= idleMs) views.push({ observerId: id, nodes: offer.nodes });
      else if (this.backingOff(state, id, at)) unanswered.add(id);
      else reads.push(byId.get(id) as ClusterNode);
    }

    const replies = await Promise.all(reads.map((node) => input.readView(node).catch(() => null)));
    replies.forEach((reply, i) => {
      const id = reads[i].id;
      if (reply && myselfOf(reply)?.id === id) {
        state.backoff.delete(id);
        views.push({ observerId: id, nodes: reply });
        return;
      }
      const failures = (state.backoff.get(id)?.failures ?? 0) + 1;
      const rounds = Math.min(2 ** (failures - 1), TOPOLOGY_DIVERGENCE_BACKOFF_MAX_ROUNDS);
      state.backoff.set(id, { failures, retryAt: at + rounds * input.intervalMs });
      unanswered.add(id);
    });
    for (const [id, backoff] of state.backoff) {
      if (!state.observers.has(id) && backoff.retryAt <= at) state.backoff.delete(id);
    }
    state.unanswered = unanswered;

    state.tracker.observe({
      at,
      disagreements: compareTopologyViews(views),
      unanswered: [...unanswered],
      views: views.length,
    });
    state.accused = this.accusedBy(views);

    const nodes = new Map<string, ClusterNode>();
    const selves = new Map<string, ClusterNode>();
    for (const view of views) {
      for (const node of view.nodes) {
        if (!nodes.has(node.id)) nodes.set(node.id, node);
        if (node.id === view.observerId) selves.set(node.id, node);
      }
    }

    return {
      clusterKey: input.clusterKey,
      anchorConnectionId: input.connectionId,
      at,
      status: views.length >= 2 ? 'ok' : 'insufficient_views',
      observers: selection.observers,
      unanswered: [...unanswered].sort(),
      disagreements: state.tracker.tracked(),
      nodes,
      selves,
    };
  }

  private backingOff(state: ClusterRounds, id: string, at: number): boolean {
    return (state.backoff.get(id)?.retryAt ?? -Infinity) > at;
  }

  private accusedBy(views: TopologyView[]): string[] {
    const accusers = new Map<string, number>();
    for (const view of views) {
      for (const node of view.nodes) {
        if (isAccused(node)) accusers.set(node.id, (accusers.get(node.id) ?? 0) + 1);
      }
    }
    return [...accusers.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id]) => id);
  }
}
