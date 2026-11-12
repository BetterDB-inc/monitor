import type { ClusterNode } from '@app/common/types/metrics.types';

export type DivergenceKind = 'slot_owner' | 'config_epoch' | 'failure_flags' | 'membership';

export interface TopologyView {
  observerId: string;
  nodes: ClusterNode[];
}

export interface DivergencePosition {
  value: string;
  observers: string[];
}

export interface TopologyDisagreement {
  key: string;
  kind: DivergenceKind;
  subjectIds: string[];
  slots?: number[][];
  positions: DivergencePosition[];
}

export interface SlotStreak {
  slots: number[][];
  firstSeenAt: number;
  rounds: number;
}

export interface TrackedDisagreement extends TopologyDisagreement {
  firstSeenAt: number;
  lastSeenAt: number;
  rounds: number;
  slotStreaks?: SlotStreak[];
}

export interface DivergenceRound {
  at: number;
  disagreements: TopologyDisagreement[];
  unanswered: string[];
  views: number;
}

export interface ConfirmationRule {
  minRounds: number;
  minAgeMs?: Partial<Record<DivergenceKind, number>>;
}

export interface DivergenceGroup {
  signature: string;
  dissent: string[];
  others: string[];
  disagreements: TrackedDisagreement[];
}

export const TOPOLOGY_DIVERGENCE_BLIND_MS = 5 * 60_000;
export const TOPOLOGY_DIVERGENCE_SIGNATURE_PREFIX = 'topology_divergence:';
export const UNASSIGNED_SLOT_OWNER = 'unassigned';

const SLOT_COUNT = 16384;
const FAILING_FLAGS = ['fail', 'fail?'];
const FINISHED_MIGRATION_STATES = ['success', 'failed', 'cancelled'];

type MemberStatus = 'known' | 'handshake' | 'noaddr';

interface ViewIndex {
  observerId: string;
  known: Map<string, ClusterNode>;
  status: Map<string, MemberStatus>;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function hostPort(address: string): string {
  return address.split('@')[0];
}

function statusOf(node: ClusterNode): MemberStatus {
  if (node.flags.includes('handshake')) return 'handshake';
  return node.flags.includes('noaddr') ? 'noaddr' : 'known';
}

function indexViews(views: TopologyView[]): ViewIndex[] {
  const idsByAddress = new Map<string, Set<string>>();
  for (const view of views) {
    for (const node of view.nodes) {
      if (statusOf(node) !== 'known') continue;
      const address = hostPort(node.address);
      const ids = idsByAddress.get(address);
      if (ids) ids.add(node.id);
      else idsByAddress.set(address, new Set([node.id]));
    }
  }

  return views.map((view) => {
    const known = new Map<string, ClusterNode>();
    const status = new Map<string, MemberStatus>();
    for (const node of view.nodes) {
      const nodeStatus = statusOf(node);
      if (nodeStatus === 'known') {
        known.set(node.id, node);
        status.set(node.id, 'known');
      } else if (nodeStatus === 'noaddr') {
        if (!status.has(node.id)) status.set(node.id, 'noaddr');
      }
    }
    for (const node of view.nodes) {
      if (statusOf(node) !== 'handshake') continue;
      const ids = idsByAddress.get(hostPort(node.address));
      if (ids?.size !== 1) continue;
      const [realId] = ids;
      if (!status.has(realId)) status.set(realId, 'handshake');
    }
    return { observerId: view.observerId, known, status };
  });
}

function positionsOf(votes: Map<string, string[]>): DivergencePosition[] {
  return [...votes.entries()]
    .map(([value, observers]) => ({ value, observers: sortedUnique(observers) }))
    .sort((a, b) => compareText(a.value, b.value));
}

function vote(votes: Map<string, string[]>, value: string, observerId: string): void {
  const observers = votes.get(value);
  if (observers) observers.push(observerId);
  else votes.set(value, [observerId]);
}

function perNodeDisagreements(indexes: ViewIndex[]): TopologyDisagreement[] {
  const subjects = sortedUnique(indexes.flatMap((index) => [...index.known.keys()]));
  const found: TopologyDisagreement[] = [];

  for (const subject of subjects) {
    const membership = new Map<string, string[]>();
    const epochs = new Map<string, string[]>();
    const failures = new Map<string, string[]>();

    for (const index of indexes) {
      vote(membership, index.status.get(subject) ?? 'missing', index.observerId);
      const node = index.known.get(subject);
      if (!node) continue;
      vote(epochs, String(node.configEpoch), index.observerId);
      if (index.observerId === subject) continue;
      const failing = node.flags.some((flag) => FAILING_FLAGS.includes(flag));
      vote(failures, failing ? 'failing' : 'ok', index.observerId);
    }

    const kinds: Array<[DivergenceKind, Map<string, string[]>]> = [
      ['membership', membership],
      ['config_epoch', epochs],
      ['failure_flags', failures],
    ];
    for (const [kind, votes] of kinds) {
      if (votes.size < 2) continue;
      found.push({ key: `${kind}:${subject}`, kind, subjectIds: [subject], positions: positionsOf(votes) });
    }
  }

  return found;
}

function slotOwners(index: ViewIndex, ids: Map<string, number>): Int32Array {
  const owners = new Int32Array(SLOT_COUNT).fill(-1);
  const epochs = new Float64Array(SLOT_COUNT).fill(-1);
  for (const node of index.known.values()) {
    if (node.slots.length === 0) continue;
    let ordinal = ids.get(node.id);
    if (ordinal === undefined) {
      ordinal = ids.size;
      ids.set(node.id, ordinal);
    }
    for (const [start, end = start] of node.slots) {
      const last = Math.min(end, SLOT_COUNT - 1);
      for (let slot = Math.max(start, 0); slot <= last; slot++) {
        if (node.configEpoch <= epochs[slot]) continue;
        owners[slot] = ordinal;
        epochs[slot] = node.configEpoch;
      }
    }
  }
  return owners;
}

function slotDisagreements(indexes: ViewIndex[]): TopologyDisagreement[] {
  const ids = new Map<string, number>();
  const owners = indexes.map((index) => slotOwners(index, ids));
  const names = [...ids.keys()];
  const nameOf = (ordinal: number) => (ordinal < 0 ? UNASSIGNED_SLOT_OWNER : names[ordinal]);
  const claims = new Map<string, { owners: string; slots: number[][]; votes: Map<string, string[]> }>();

  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const first = owners[0][slot];
    if (owners.every((view) => view[slot] === first)) continue;

    const claim = owners.map((view) => view[slot]).join(',');
    let dispute = claims.get(claim);
    if (!dispute) {
      const votes = new Map<string, string[]>();
      owners.forEach((view, at) => vote(votes, nameOf(view[slot]), indexes[at].observerId));
      dispute = { owners: sortedUnique([...votes.keys()]).join('|'), slots: [], votes };
      claims.set(claim, dispute);
    }
    const lastRange = dispute.slots[dispute.slots.length - 1];
    if (lastRange && lastRange[1] === slot - 1) lastRange[1] = slot;
    else dispute.slots.push([slot, slot]);
  }

  const sameOwners = new Map<string, number>();
  return [...claims.values()].map((dispute) => {
    const nth = (sameOwners.get(dispute.owners) ?? 0) + 1;
    sameOwners.set(dispute.owners, nth);
    const key = `slot_owner:${dispute.owners}${nth > 1 ? `#${nth}` : ''}`;
    const positions = positionsOf(dispute.votes);
    return {
      key,
      kind: 'slot_owner' as const,
      subjectIds: positions.map((position) => position.value).filter((value) => value !== UNASSIGNED_SLOT_OWNER),
      slots: dispute.slots,
      positions,
    };
  });
}

export function compareTopologyViews(views: TopologyView[]): TopologyDisagreement[] {
  if (views.length < 2) return [];
  const indexes = indexViews(views);
  return [...perNodeDisagreements(indexes), ...slotDisagreements(indexes)].sort((a, b) =>
    compareText(a.key, b.key),
  );
}

export function intersectSlotRanges(a: number[][], b: number[][]): number[][] {
  const shared: number[][] = [];
  for (const [aStart, aEnd = aStart] of a) {
    for (const [bStart, bEnd = bStart] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (start <= end) shared.push([start, end]);
    }
  }
  return shared.sort((x, y) => x[0] - y[0]);
}

function mergeSlotRanges(ranges: number[][]): number[][] {
  const merged: number[][] = [];
  for (const [start, end = start] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function subtractSlotRanges(from: number[][], taken: number[][]): number[][] {
  const gone = mergeSlotRanges(taken);
  const left: number[][] = [];
  for (const [start, end = start] of from) {
    let next = start;
    for (const [goneStart, goneEnd] of gone) {
      if (goneEnd < next || goneStart > end) continue;
      if (goneStart > next) left.push([next, goneStart - 1]);
      next = goneEnd + 1;
    }
    if (next <= end) left.push([next, end]);
  }
  return left;
}

function parseSlotRangeList(text: string | undefined): number[][] {
  return (text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((range) => range.split('-').map(Number))
    .filter((range) => range.every(Number.isInteger))
    .map(([start, end = start]) => [start, end]);
}

export function migrationTouchesSlots(
  slots: number[][],
  self: ClusterNode | null,
  jobs: ReadonlyArray<Record<string, string>>,
): boolean {
  const marked = [...(self?.migratingSlots ?? []), ...(self?.importingSlots ?? [])].map(({ slot }) => [slot, slot]);
  const moving = jobs
    .filter((job) => !FINISHED_MIGRATION_STATES.includes(job.state))
    .flatMap((job) => parseSlotRangeList(job.slot_ranges));
  return intersectSlotRanges(slots, [...marked, ...moving]).length > 0;
}

function dissentCandidates(disagreement: TopologyDisagreement): string[][] {
  const largest = Math.max(...disagreement.positions.map((position) => position.observers.length));
  return disagreement.positions
    .filter((position) => position.observers.length === largest)
    .map((majority) =>
      sortedUnique(
        disagreement.positions.filter((position) => position !== majority).flatMap((position) => position.observers),
      ),
    )
    .sort((a, b) => compareText(a.join(','), b.join(',')));
}

export function dissentOf(disagreement: TopologyDisagreement): string[] {
  return dissentCandidates(disagreement)[0] ?? [];
}

export class DivergenceTracker {
  private readonly entries = new Map<string, TrackedDisagreement>();

  observe(round: DivergenceRound): void {
    const comparable = round.views >= 2;
    const seen = new Set<string>();
    if (comparable) {
      for (const disagreement of round.disagreements) {
        seen.add(disagreement.key);
        this.entries.set(disagreement.key, this.advance(disagreement, round.at));
      }
    }

    const unanswered = new Set(round.unanswered);
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue;
      const answeringSides = entry.positions.filter((position) =>
        position.observers.some((observer) => !unanswered.has(observer)),
      ).length;
      const unseeable = !comparable || answeringSides < 2;
      if (!unseeable || round.at - entry.lastSeenAt > TOPOLOGY_DIVERGENCE_BLIND_MS) this.entries.delete(key);
    }
  }

  tracked(): TrackedDisagreement[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => compareText(a.key, b.key));
  }

  restart(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private advance(disagreement: TopologyDisagreement, at: number): TrackedDisagreement {
    const previous = this.entries.get(disagreement.key);
    if (disagreement.slots?.length) {
      const slotStreaks = this.slotStreaksAfter(previous?.slotStreaks ?? [], disagreement.slots, at);
      const [{ firstSeenAt, rounds }] = slotStreaks;
      return { ...disagreement, firstSeenAt, lastSeenAt: at, rounds, slotStreaks };
    }
    if (!previous) return { ...disagreement, firstSeenAt: at, lastSeenAt: at, rounds: 1 };
    return { ...disagreement, firstSeenAt: previous.firstSeenAt, lastSeenAt: at, rounds: previous.rounds + 1 };
  }

  private slotStreaksAfter(previous: SlotStreak[], slots: number[][], at: number): SlotStreak[] {
    const lasting = previous
      .map((streak) => ({ ...streak, slots: intersectSlotRanges(streak.slots, slots), rounds: streak.rounds + 1 }))
      .filter((streak) => streak.slots.length > 0);
    const joined = subtractSlotRanges(
      slots,
      previous.flatMap((streak) => streak.slots),
    );
    return joined.length > 0 ? [...lasting, { slots: joined, firstSeenAt: at, rounds: 1 }] : lasting;
  }
}

export function confirmedDisagreements(
  tracked: TrackedDisagreement[],
  at: number,
  rule: ConfirmationRule,
): TrackedDisagreement[] {
  return tracked.flatMap((entry) => {
    if (entry.lastSeenAt < at || entry.rounds < rule.minRounds) return [];
    if (at - entry.firstSeenAt < (rule.minAgeMs?.[entry.kind] ?? 0)) return [];
    if (!entry.slotStreaks) return [entry];
    const lasting = entry.slotStreaks.filter((streak) => streak.rounds >= rule.minRounds);
    return [{ ...entry, slots: mergeSlotRanges(lasting.flatMap((streak) => streak.slots)) }];
  });
}

export function divergenceSignature(dissent: string[]): string {
  return `${TOPOLOGY_DIVERGENCE_SIGNATURE_PREFIX}${dissent.join(',')}`;
}

export function groupDivergences(tracked: TrackedDisagreement[]): DivergenceGroup[] {
  const members = new Map<string, { dissent: string[]; disagreements: TrackedDisagreement[] }>();
  const join = (dissent: string[], disagreement: TrackedDisagreement) => {
    const signature = divergenceSignature(dissent);
    const group = members.get(signature);
    if (group) group.disagreements.push(disagreement);
    else members.set(signature, { dissent, disagreements: [disagreement] });
  };

  const split: Array<{ disagreement: TrackedDisagreement; candidates: string[][] }> = [];
  for (const disagreement of tracked) {
    const candidates = dissentCandidates(disagreement);
    if (candidates.length === 1) join(candidates[0], disagreement);
    else if (candidates.length > 1) split.push({ disagreement, candidates });
  }
  split.sort((a, b) => compareText(a.disagreement.key, b.disagreement.key));
  for (const { disagreement, candidates } of split) {
    const settled = candidates.find((candidate) => members.has(divergenceSignature(candidate)));
    join(settled ?? candidates[0], disagreement);
  }

  return [...members.entries()]
    .map(([signature, group]) => {
      const dissent = new Set(group.dissent);
      const observers = group.disagreements.flatMap((d) => d.positions.flatMap((position) => position.observers));
      return {
        signature,
        dissent: group.dissent,
        others: sortedUnique(observers).filter((observer) => !dissent.has(observer)),
        disagreements: group.disagreements.sort((a, b) => compareText(a.key, b.key)),
      };
    })
    .sort((a, b) => compareText(a.signature, b.signature));
}

export interface OpenDivergence {
  group?: DivergenceGroup;
  lastCountedAt: number;
  clean: number;
}

export function settleOpenDivergences(input: {
  open: Map<string, OpenDivergence>;
  openSignatures: Iterable<string>;
  confirmed: DivergenceGroup[];
  pendingSignatures: ReadonlySet<string>;
  comparable: boolean;
  at: number;
  minRounds: number;
}): Set<string> {
  const { open, at } = input;
  const signatures = new Set(input.openSignatures);
  for (const signature of signatures) {
    if (!open.has(signature)) open.set(signature, { lastCountedAt: at, clean: 0 });
  }
  for (const signature of [...open.keys()]) {
    if (!signatures.has(signature)) open.delete(signature);
  }

  const confirmed = new Map(input.confirmed.map((group) => [group.signature, group]));
  const kept = new Set<string>();
  for (const [signature, entry] of open) {
    const group = confirmed.get(signature);
    if (group) {
      open.set(signature, { group, lastCountedAt: at, clean: 0 });
      continue;
    }
    const pending = input.pendingSignatures.has(signature);
    if (pending) entry.clean = 0;
    if (!input.comparable) {
      if (at - entry.lastCountedAt <= TOPOLOGY_DIVERGENCE_BLIND_MS) kept.add(signature);
      continue;
    }
    if (pending) {
      entry.lastCountedAt = at;
      kept.add(signature);
      continue;
    }
    entry.clean += 1;
    if (entry.clean < input.minRounds) kept.add(signature);
  }
  return kept;
}
