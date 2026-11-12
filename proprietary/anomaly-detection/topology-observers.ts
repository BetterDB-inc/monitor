import type { ClusterNode } from '@app/common/types/metrics.types';

export interface ObserverSelectionInput {
  nodes: ClusterNode[];
  anchorId: string;
  registeredIds: ReadonlySet<string>;
  previous: readonly string[];
  unanswered: ReadonlySet<string>;
  frozen: ReadonlySet<string>;
  accused: readonly string[];
  nodesPerZone: number;
  randomNodes: number;
  maxObservers: number;
  maxAccused: number;
  random: () => number;
}

export interface ObserverSelection {
  observers: string[];
  sampled: string[];
  followed: string[];
}

const UNKNOWN_ZONE = '';
const UNREACHABLE_FLAGS = ['handshake', 'noaddr'];
const FAILING_FLAGS = ['fail', 'fail?'];
const RANK_UNREGISTERED = 1;
const RANK_FAILING = 2;
const RANK_SILENT = 4;
const RANK_REPLICA = 8;

function isPrimary(node: ClusterNode): boolean {
  return node.flags.includes('master');
}

function zoneOf(node: ClusterNode): string {
  return node.availabilityZone || UNKNOWN_ZONE;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function selectObservers(input: ObserverSelectionInput): ObserverSelection {
  const eligible = input.nodes
    .filter((node) => !node.flags.some((flag) => UNREACHABLE_FLAGS.includes(flag)))
    .sort((a, b) => compareText(a.id, b.id));
  const byId = new Map(eligible.map((node) => [node.id, node]));
  const sampled: string[] = [];
  const taken = new Set<string>();
  const take = (id: string) => {
    if (!byId.has(id) || taken.has(id)) return;
    taken.add(id);
    sampled.push(id);
  };

  const rank = (node: ClusterNode, replicaPenalty: boolean) =>
    (input.registeredIds.has(node.id) ? 0 : RANK_UNREGISTERED) +
    (node.flags.some((flag) => FAILING_FLAGS.includes(flag)) ? RANK_FAILING : 0) +
    (input.unanswered.has(node.id) ? RANK_SILENT : 0) +
    (replicaPenalty && !isPrimary(node) && !input.registeredIds.has(node.id) ? RANK_REPLICA : 0);

  const drawOrder = (candidates: ClusterNode[], replicaPenalty: boolean, limit: number): string[] => {
    const pool = candidates.filter((node) => !taken.has(node.id));
    const kept = input.previous.filter(
      (id) => !input.unanswered.has(id) && pool.some((node) => node.id === id),
    );
    const rest = pool.filter((node) => !kept.includes(node.id));
    const drawn: string[] = [];
    while (rest.length > 0 && kept.length + drawn.length < limit) {
      const best = Math.min(...rest.map((node) => rank(node, replicaPenalty)));
      const tier = rest.filter((node) => rank(node, replicaPenalty) === best);
      const pick = tier[Math.min(Math.floor(input.random() * tier.length), tier.length - 1)];
      drawn.push(pick.id);
      rest.splice(rest.indexOf(pick), 1);
    }
    return [...kept, ...drawn];
  };

  take(input.anchorId);
  const priority = new Set(taken);
  for (const id of input.previous) {
    if (!input.frozen.has(id)) continue;
    take(id);
    if (taken.has(id)) priority.add(id);
  }

  const zones = [...new Set(eligible.map(zoneOf))].sort((a, b) => {
    if (a === UNKNOWN_ZONE) return 1;
    return b === UNKNOWN_ZONE ? -1 : compareText(a, b);
  });
  const lanes = zones.map((zone) => {
    const members = eligible.filter((node) => zoneOf(node) === zone);
    const hasPrimary = members.some(isPrimary);
    const candidates = members.filter(
      (node) => !hasPrimary || isPrimary(node) || input.registeredIds.has(node.id),
    );
    const quota = zone === UNKNOWN_ZONE ? input.randomNodes : input.nodesPerZone;
    const held = members.filter((node) => taken.has(node.id)).map((node) => node.id);
    return [...held, ...drawOrder(candidates, false, quota)].slice(0, Math.max(quota, 0));
  });
  const deepest = Math.max(0, ...lanes.map((lane) => lane.length));
  for (let turn = 0; turn < deepest; turn++) {
    for (const lane of lanes) {
      if (lane[turn]) take(lane[turn]);
    }
  }

  for (const id of drawOrder(eligible, true, input.randomNodes)) {
    if (sampled.length >= input.randomNodes) break;
    take(id);
  }

  const followed = input.accused
    .filter((id) => byId.has(id) && !taken.has(id))
    .slice(0, Math.max(input.maxAccused, 0));
  const observers = [
    ...sampled.filter((id) => priority.has(id)),
    ...followed,
    ...sampled.filter((id) => !priority.has(id)),
  ].slice(0, Math.max(input.maxObservers, 1));
  const kept = new Set(observers);

  return {
    observers,
    sampled: sampled.filter((id) => kept.has(id)),
    followed: followed.filter((id) => kept.has(id)),
  };
}
