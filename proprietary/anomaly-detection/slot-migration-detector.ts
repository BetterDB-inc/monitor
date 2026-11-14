import type { SlotMigration, SlotMigrationReport } from '@app/cluster/cluster-metrics.service';

export const ATOMIC_MIGRATION_STALL_MS = 10 * 60_000;
export const LEGACY_MIGRATION_STALL_MS = 30 * 60_000;

const MAX_REASON_LENGTH = 200;
const SHORT_NODE_ID_LENGTH = 8;
const SNAPSHOT_ARRIVING_PHASE = 'receiving-snapshot';
const JOB_MOVE = 'job:';
const LEGACY_MOVE = 'legacy:';

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
  stamps: Readonly<Record<string, string>>;
  since: number;
  atomic: boolean;
  nodeIds: string[];
  stuckBefore: boolean;
}

export interface SlotMigrationWatch {
  moves: ReadonlyMap<string, WatchedMove>;
  knownFailed: ReadonlySet<string>;
  seenNodes: ReadonlySet<string>;
  seenJobNodes: ReadonlySet<string>;
  adopted: ReadonlySet<string>;
}

export interface SlotMigrationJudgement {
  watch: SlotMigrationWatch;
  running: SlotMigrationFinding[];
  stuck: SlotMigrationFinding[];
  failed: SlotMigrationFinding[];
  unseen: Set<string>;
  held: Set<string>;
}

interface Move {
  id: string;
  atomic: boolean;
  timed: boolean;
  slots: string;
  stamps: Record<string, string>;
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
  seenJobNodes: new Set(),
  adopted: new Set(),
};

interface Sight {
  seenBefore: ReadonlySet<string>;
  readNow: ReadonlySet<string>;
  complete: boolean;
}

export function withAdoptedSlotMigrations(
  watch: SlotMigrationWatch | undefined,
  signatures: Iterable<string>,
): SlotMigrationWatch {
  const known = watch ?? EMPTY_WATCH;
  return { ...known, adopted: new Set([...known.adopted, ...signatures]) };
}

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

function hasHeartbeat(migration: SlotMigration): boolean {
  if (migration.lastUpdateAt === undefined && migration.lastAckAt === undefined) return false;
  return !(migration.state === 'importing' && migration.phase === SNAPSHOT_ARRIVING_PHASE);
}

function stampOf(migration: SlotMigration): string {
  return `${migration.phase ?? ''}|${migration.lastUpdateAt ?? ''}|${migration.lastAckAt ?? ''}`;
}

function movesOf(report: SlotMigrationReport): Move[] {
  const views = new Map<string, Record<string, string>>();
  for (const view of report.jobViews) {
    if (view.jobName === undefined) continue;
    views.set(view.jobName, { ...views.get(view.jobName), [view.state]: stampOf(view) });
  }
  const moves: Move[] = [];
  const legacy = new Map<string, { first: SlotMigration; slots: number[] }>();
  for (const migration of report.migrations) {
    if (migration.jobName !== undefined) {
      moves.push({
        id: `${JOB_MOVE}${migration.jobName}`,
        atomic: true,
        timed: hasHeartbeat(migration),
        slots: migration.slotRange ?? `${migration.slot}`,
        stamps: views.get(migration.jobName) ?? { [migration.state]: stampOf(migration) },
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
      id: `${LEGACY_MOVE}${pair}`,
      atomic: false,
      timed: true,
      slots: ranges,
      stamps: { [LEGACY_MOVE]: ranges },
      ...endpoints(first),
    });
  }
  return moves;
}

function changed(
  before: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(now).some(
    ([view, stamp]) => before[view] !== undefined && before[view] !== stamp,
  );
}

function couldNotBeSeen(move: WatchedMove, sight: Sight): boolean {
  if (sight.complete) return false;
  const watched = move.nodeIds.filter((nodeId) => sight.seenBefore.has(nodeId));
  if (watched.length === 0) return true;
  const unread = (nodeId: string) => !sight.readNow.has(nodeId);
  return move.atomic ? watched.every(unread) : watched.some(unread);
}

function endedWhileUnwatched(id: string, report: SlotMigrationReport, markers: Sight): boolean {
  if (id.startsWith(JOB_MOVE)) {
    return report.complete || report.finishedJobs.includes(id.slice(JOB_MOVE.length));
  }
  if (markers.complete) return true;
  const ends = id.slice(LEGACY_MOVE.length).split('>');
  return ends.every((nodeId) => markers.readNow.has(nodeId));
}

export function judgeSlotMigrations(
  previous: SlotMigrationWatch | undefined,
  report: SlotMigrationReport,
  now: number,
): SlotMigrationJudgement {
  const watch = previous ?? EMPTY_WATCH;
  const markers: Sight = {
    seenBefore: watch.seenNodes,
    readNow: new Set(report.readNodeIds),
    complete: report.markersComplete,
  };
  const jobs: Sight = {
    seenBefore: watch.seenJobNodes,
    readNow: new Set(report.jobsReadNodeIds),
    complete: report.complete,
  };
  const moves = new Map<string, WatchedMove>();
  const running: SlotMigrationFinding[] = [];
  const stuck: SlotMigrationFinding[] = [];
  const failed: SlotMigrationFinding[] = [];
  const unseen = new Set<string>();
  const held = new Set<string>();
  const listed = new Set<string>();

  for (const move of movesOf(report)) {
    const known = watch.moves.get(move.id);
    const unchanged = known !== undefined && !changed(known.stamps, move.stamps);
    const since = known && unchanged ? known.since : now;
    const stuckSignature = `stuck:${move.id}`;
    const stuckBefore =
      (!known || unchanged) && (known?.stuckBefore === true || watch.adopted.has(stuckSignature));
    listed.add(move.id);
    moves.set(move.id, {
      stamps: { ...known?.stamps, ...move.stamps },
      since,
      atomic: move.atomic,
      nodeIds: [move.sourceNodeId, move.targetNodeId].filter((nodeId) => nodeId !== ''),
      stuckBefore,
    });
    const { id, stamps: _stamps, timed, ...shown } = move;
    running.push({ kind: 'running', signature: `running:${id}`, ...shown });
    const quietMs = now - since;
    const stallMs = move.atomic ? ATOMIC_MIGRATION_STALL_MS : LEGACY_MIGRATION_STALL_MS;
    if (timed && quietMs >= stallMs) {
      stuck.push({ kind: 'stuck', signature: stuckSignature, ...shown, quietMs });
    } else if (stuckBefore) {
      held.add(stuckSignature);
    }
  }

  for (const [id, move] of watch.moves) {
    if (moves.has(id) || !couldNotBeSeen(move, move.atomic ? jobs : markers)) continue;
    moves.set(id, move);
    unseen.add(`running:${id}`);
    unseen.add(`stuck:${id}`);
  }

  const adopted = new Set<string>();
  for (const signature of watch.adopted) {
    const id = signature.slice(signature.indexOf(':') + 1);
    if (listed.has(id) || endedWhileUnwatched(id, report, markers)) continue;
    adopted.add(signature);
    held.add(signature);
  }

  const knownFailed = new Set(report.complete ? [] : watch.knownFailed);
  for (const job of report.failed) {
    knownFailed.add(job.jobName);
    if (watch.knownFailed.has(job.jobName)) continue;
    const wasRunning = watch.moves.has(`${JOB_MOVE}${job.jobName}`);
    const wasWatched =
      jobs.seenBefore.has(job.sourceNodeId) || jobs.seenBefore.has(job.targetNodeId);
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

  const seen = (sight: Sight) =>
    new Set(sight.complete ? sight.readNow : [...sight.seenBefore, ...sight.readNow]);
  return {
    watch: { moves, knownFailed, seenNodes: seen(markers), seenJobNodes: seen(jobs), adopted },
    running,
    stuck,
    failed,
    unseen,
    held,
  };
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
      `memory for the slots. To stop it, run CLUSTER CANCELSLOTMIGRATIONS on ${source}. ` +
      `That cancels every migration that node is the source of, not only this one.`
    );
  }
  return (
    `WARNING: Slot migration stuck: ${move} has had the same MIGRATING or IMPORTING markers ` +
    `for ${quiet}. The tool that was moving the slots may have stopped. Finish the move with ` +
    `that tool, or repair the open slots with the cluster fix command of valkey-cli or redis-cli.`
  );
}
