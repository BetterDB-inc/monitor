import type { SlotMigration, SlotMigrationReport } from '@app/cluster/cluster-metrics.service';

export const ATOMIC_MIGRATION_STALL_MS = 10 * 60_000;
export const LEGACY_MIGRATION_STALL_MS = 30 * 60_000;

const MAX_REASON_LENGTH = 200;
const SHORT_NODE_ID_LENGTH = 8;

export type SlotMigrationFindingKind = 'running' | 'stuck' | 'failed';

export interface SlotMigrationFinding {
  kind: SlotMigrationFindingKind;
  signature: string;
  atomic: boolean;
  slots: string;
  sourceNodeId: string;
  sourceAddress: string;
  targetNodeId: string;
  targetAddress: string;
  phase?: string;
  quietMs?: number;
  reason?: string;
}

interface WatchedMove {
  stamp: string;
  since: number;
  atomic: boolean;
  nodeIds: string[];
}

export interface SlotMigrationWatch {
  moves: ReadonlyMap<string, WatchedMove>;
  knownFailed: ReadonlySet<string>;
  seenNodes: ReadonlySet<string>;
}

export interface SlotMigrationJudgement {
  watch: SlotMigrationWatch;
  running: SlotMigrationFinding[];
  stuck: SlotMigrationFinding[];
  failed: SlotMigrationFinding[];
  unseen: Set<string>;
}

interface Move {
  id: string;
  atomic: boolean;
  slots: string;
  stamp: string;
  phase?: string;
  sourceNodeId: string;
  sourceAddress: string;
  targetNodeId: string;
  targetAddress: string;
}

const EMPTY_WATCH: SlotMigrationWatch = {
  moves: new Map(),
  knownFailed: new Set(),
  seenNodes: new Set(),
};

function asRanges(slots: number[]): string {
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    ranges.push(end === i ? `${sorted[i]}` : `${sorted[i]}-${sorted[end]}`);
    i = end + 1;
  }
  return ranges.join(' ');
}

function endpoints(migration: SlotMigration) {
  return {
    sourceNodeId: migration.sourceNodeId,
    sourceAddress: migration.sourceAddress,
    targetNodeId: migration.targetNodeId,
    targetAddress: migration.targetAddress,
  };
}

function movesOf(migrations: SlotMigration[]): Move[] {
  const moves: Move[] = [];
  const legacy = new Map<string, { first: SlotMigration; slots: number[] }>();
  for (const migration of migrations) {
    if (migration.jobName !== undefined) {
      moves.push({
        id: `job:${migration.jobName}`,
        atomic: true,
        slots: migration.slotRange ?? `${migration.slot}`,
        stamp: `${migration.phase ?? ''}|${migration.lastUpdateAt ?? ''}|${migration.lastAckAt ?? ''}`,
        phase: migration.phase,
        ...endpoints(migration),
      });
      continue;
    }
    const pair = `${migration.sourceNodeId}>${migration.targetNodeId}`;
    const known = legacy.get(pair);
    if (known) known.slots.push(migration.slot);
    else legacy.set(pair, { first: migration, slots: [migration.slot] });
  }
  for (const [pair, { first, slots }] of legacy) {
    const ranges = asRanges(slots);
    moves.push({
      id: `legacy:${pair}`,
      atomic: false,
      slots: ranges,
      stamp: ranges,
      ...endpoints(first),
    });
  }
  return moves;
}

function couldNotBeSeen(
  move: WatchedMove,
  seenBefore: ReadonlySet<string>,
  readNow: ReadonlySet<string>,
  complete: boolean,
): boolean {
  if (complete) return false;
  const watched = move.nodeIds.filter((nodeId) => seenBefore.has(nodeId));
  if (watched.length === 0) return true;
  const unread = (nodeId: string) => !readNow.has(nodeId);
  return move.atomic ? watched.every(unread) : watched.some(unread);
}

export function judgeSlotMigrations(
  previous: SlotMigrationWatch | undefined,
  report: SlotMigrationReport,
  now: number,
): SlotMigrationJudgement {
  const watch = previous ?? EMPTY_WATCH;
  const readNow = new Set(report.readNodeIds);
  const moves = new Map<string, WatchedMove>();
  const running: SlotMigrationFinding[] = [];
  const stuck: SlotMigrationFinding[] = [];
  const failed: SlotMigrationFinding[] = [];
  const unseen = new Set<string>();

  for (const move of movesOf(report.migrations)) {
    const known = watch.moves.get(move.id);
    const since = known && known.stamp === move.stamp ? known.since : now;
    moves.set(move.id, {
      stamp: move.stamp,
      since,
      atomic: move.atomic,
      nodeIds: [move.sourceNodeId, move.targetNodeId].filter((nodeId) => nodeId !== ''),
    });
    const { id, stamp: _stamp, ...shown } = move;
    running.push({ kind: 'running', signature: `running:${id}`, ...shown });
    const quietMs = now - since;
    if (quietMs >= (move.atomic ? ATOMIC_MIGRATION_STALL_MS : LEGACY_MIGRATION_STALL_MS)) {
      stuck.push({ kind: 'stuck', signature: `stuck:${id}`, ...shown, quietMs });
    }
  }

  for (const [id, move] of watch.moves) {
    if (moves.has(id) || !couldNotBeSeen(move, watch.seenNodes, readNow, report.complete)) continue;
    moves.set(id, move);
    unseen.add(`running:${id}`);
    unseen.add(`stuck:${id}`);
  }

  const knownFailed = new Set(report.complete ? [] : watch.knownFailed);
  for (const job of report.failed) {
    knownFailed.add(job.jobName);
    if (watch.knownFailed.has(job.jobName)) continue;
    const wasRunning = watch.moves.has(`job:${job.jobName}`);
    const wasWatched =
      watch.seenNodes.has(job.sourceNodeId) || watch.seenNodes.has(job.targetNodeId);
    if (!wasRunning && !wasWatched) continue;
    failed.push({
      kind: 'failed',
      signature: `failed:${job.jobName}`,
      atomic: true,
      slots: job.slotRange,
      sourceNodeId: job.sourceNodeId,
      sourceAddress: job.sourceAddress,
      targetNodeId: job.targetNodeId,
      targetAddress: job.targetAddress,
      reason: job.message,
    });
  }

  const seenNodes = new Set(report.complete ? readNow : [...watch.seenNodes, ...readNow]);
  return { watch: { moves, knownFailed, seenNodes }, running, stuck, failed, unseen };
}

function nodeLabel(address: string, nodeId: string): string {
  if (address !== '') return address;
  return nodeId === '' ? 'an unknown node' : `node ${nodeId.slice(0, SHORT_NODE_ID_LENGTH)}`;
}

function minutes(ms: number): string {
  const count = Math.floor(ms / 60_000);
  return `${count} minute${count === 1 ? '' : 's'}`;
}

function oneLine(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH)}...` : flat;
}

export function describeSlotMigration(finding: SlotMigrationFinding): string {
  const source = nodeLabel(finding.sourceAddress, finding.sourceNodeId);
  const target = nodeLabel(finding.targetAddress, finding.targetNodeId);
  const noun = /[-\s]/.test(finding.slots) ? 'slots' : 'slot';
  const move = `${noun} ${finding.slots} from ${source} to ${target}`;
  const state = finding.phase ? ` (state: ${oneLine(finding.phase)})` : '';

  if (finding.kind === 'running') {
    return `INFO: Slot migration running: ${move}${state}. This entry closes when the migration ends.`;
  }
  if (finding.kind === 'failed') {
    const reason = oneLine(finding.reason ?? '');
    const said = reason === '' ? 'The server gave no reason.' : `The server said: "${reason}".`;
    return (
      `WARNING: Slot migration failed: ${move}. ${said} ` +
      `Check both nodes, then start the migration again if it is still wanted.`
    );
  }
  const quiet = minutes(finding.quietMs ?? 0);
  if (finding.atomic) {
    return (
      `WARNING: Slot migration stuck: ${move} has reported no state change and no heartbeat ` +
      `for ${quiet}${state}. Check that the two nodes reach each other and that the target has ` +
      `memory for the slots. To stop it, run CLUSTER CANCELSLOTMIGRATIONS on ${source}.`
    );
  }
  return (
    `WARNING: Slot migration stuck: ${move} has had the same MIGRATING or IMPORTING markers ` +
    `for ${quiet}. The tool that was moving the slots may have stopped. Finish the move with ` +
    `that tool, or repair the open slots with the cluster fix command of valkey-cli or redis-cli.`
  );
}
