import type { SlotMigration, SlotMigrationReport } from '@app/cluster/cluster-metrics.service';

export const ATOMIC_MIGRATION_STALL_MS = 10 * 60_000;
export const LEGACY_MIGRATION_STALL_MS = 30 * 60_000;
const FAILING_IMPORT_QUIET_MS = 10 * 60_000;
const FAILING_IMPORT_MIN_FAILURES = 3;

const MAX_REASON_LENGTH = 200;
const SHORT_NODE_ID_LENGTH = 8;
const SNAPSHOT_TAKING_PHASE = 'snapshotting';
const TRACKING_PHASE = 'occurring-on-primary';
const FAILED_PHASE = 'failed';
const SOURCE_VIEW = 'migrating';
const IMPORT_VIEW = 'importing';
const TRACKING_VIEW = 'tracking';
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
  importFailing?: boolean;
  jobName?: string;
  retries?: number;
}

interface ViewMark {
  stamp: string;
  timed: boolean;
  backlog?: number;
  retries?: number;
  failed?: boolean;
  lastError?: string;
}

type Views = Readonly<Record<string, ViewMark>>;

interface Failing {
  since: number;
  lastAt: number;
  count: number;
}

interface WatchedMove {
  views: Views;
  since: number;
  sourceSince?: number;
  failing?: Failing;
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
  slots: string;
  views: Views;
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

function viewOf(migration: SlotMigration): string {
  const tracking =
    migration.phase === TRACKING_PHASE ||
    migration.sourceNodeId === '' ||
    migration.targetNodeId === '';
  return tracking ? TRACKING_VIEW : migration.state;
}

function markOf(migration: SlotMigration): ViewMark {
  const mark: ViewMark = {
    stamp: `${migration.phase ?? ''}|${migration.lastUpdateAt ?? ''}`,
    timed: migration.lastUpdateAt !== undefined && migration.phase !== SNAPSHOT_TAKING_PHASE,
    backlog: migration.remainingReplBytes,
  };
  if (migration.retries === undefined) return mark;
  return {
    ...mark,
    retries: migration.retries,
    failed: migration.phase === FAILED_PHASE,
    lastError: migration.lastError,
  };
}

function newFailures(before: Views | undefined, now: Views): number {
  const mark = now[IMPORT_VIEW];
  if (mark?.retries === undefined) return 0;
  const known = before?.[IMPORT_VIEW]?.retries;
  const retried = known === undefined ? 0 : mark.retries - known;
  if (retried > 0) return retried;
  return mark.failed ? 1 : 0;
}

function failingOf(
  known: Failing | undefined,
  failures: number,
  adopted: boolean,
  now: number,
): Failing | undefined {
  if (failures > 0) {
    return { since: known?.since ?? now, lastAt: now, count: (known?.count ?? 0) + failures };
  }
  if (known && now - known.lastAt > FAILING_IMPORT_QUIET_MS) return undefined;
  return known ?? (adopted ? { since: now, lastAt: now, count: 0 } : undefined);
}

export function isStuckFailingImport(
  watch: SlotMigrationWatch | undefined,
  jobName: string,
): boolean {
  const move = watch?.moves.get(`${JOB_MOVE}${jobName}`);
  return move?.failing !== undefined && move.stuckBefore;
}

function movesOf(report: SlotMigrationReport): Move[] {
  const views = new Map<string, Record<string, ViewMark>>();
  for (const view of report.jobViews) {
    if (view.jobName === undefined) continue;
    views.set(view.jobName, { ...views.get(view.jobName), [viewOf(view)]: markOf(view) });
  }
  const moves: Move[] = [];
  const legacy = new Map<string, { first: SlotMigration; slots: number[] }>();
  for (const migration of report.migrations) {
    if (migration.jobName !== undefined) {
      moves.push({
        id: `${JOB_MOVE}${migration.jobName}`,
        atomic: true,
        slots: migration.slotRange ?? `${migration.slot}`,
        views: views.get(migration.jobName) ?? { [viewOf(migration)]: markOf(migration) },
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
      slots: ranges,
      views: { [LEGACY_MOVE]: { stamp: ranges, timed: true } },
      ...endpoints(first),
    });
  }
  return moves;
}

function progressed(before: Views, now: Views): boolean {
  return Object.entries(now).some(([view, mark]) => {
    const known = before[view];
    if (known === undefined) return false;
    if (known.stamp !== mark.stamp) return true;
    return (
      known.backlog !== undefined && mark.backlog !== undefined && mark.backlog < known.backlog
    );
  });
}

function isTimed(atomic: boolean, views: Views, now: Views): boolean {
  if (atomic && now[SOURCE_VIEW] === undefined) return false;
  return Object.entries(views).every(([view, mark]) => view === TRACKING_VIEW || mark.timed);
}

function merged(before: Views, now: Views): Views {
  const views = { ...before };
  for (const [view, mark] of Object.entries(now)) {
    const known = before[view];
    const lowest =
      known?.stamp === mark.stamp && known.backlog !== undefined && mark.backlog !== undefined
        ? Math.min(known.backlog, mark.backlog)
        : mark.backlog;
    views[view] = { ...mark, backlog: lowest };
  }
  return views;
}

function couldNotBeSeen(move: WatchedMove, sight: Sight): boolean {
  if (sight.complete) return false;
  const watched = move.nodeIds.filter((nodeId) => sight.seenBefore.has(nodeId));
  if (watched.length === 0) return true;
  const unread = (nodeId: string) => !sight.readNow.has(nodeId);
  return move.atomic ? watched.every(unread) : watched.some(unread);
}

function endedWhileUnwatched(
  id: string,
  report: SlotMigrationReport,
  markers: Sight,
  finished: ReadonlySet<string>,
): boolean {
  if (id.startsWith(JOB_MOVE)) return report.complete || finished.has(id);
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
  const finished = new Set(report.finishedJobs.map((name) => `${JOB_MOVE}${name}`));

  for (const move of movesOf(report)) {
    const known = watch.moves.get(move.id);
    const unchanged = known !== undefined && !progressed(known.views, move.views);
    const since = known && unchanged ? known.since : now;
    const sourceRead = move.views[SOURCE_VIEW] !== undefined;
    const sourceSince =
      (unchanged ? known?.sourceSince : undefined) ?? (sourceRead ? now : undefined);
    const views = merged(known?.views ?? {}, move.views);
    const stuckSignature = `stuck:${move.id}`;
    const adopted = watch.adopted.has(stuckSignature);
    const retrying = Object.values(views).some((mark) => mark.retries !== undefined);
    const failing = retrying
      ? failingOf(known?.failing, newFailures(known?.views, move.views), adopted, now)
      : undefined;
    const failedTooLong =
      failing !== undefined &&
      failing.count >= FAILING_IMPORT_MIN_FAILURES &&
      now - failing.since >= ATOMIC_MIGRATION_STALL_MS;
    const quietMs = failedTooLong ? now - failing.since : now - since;
    const watchedMs = move.atomic ? now - (sourceSince ?? now) : quietMs;
    const stallMs = move.atomic ? ATOMIC_MIGRATION_STALL_MS : LEGACY_MIGRATION_STALL_MS;
    const isStuck =
      failedTooLong || (watchedMs >= stallMs && isTimed(move.atomic, views, move.views));
    const heldBefore = known?.stuckBefore === true || adopted;
    const stuckBefore =
      isStuck || ((retrying ? failing !== undefined : !known || unchanged) && heldBefore);
    listed.add(move.id);
    moves.set(move.id, {
      views,
      since,
      sourceSince,
      failing,
      atomic: move.atomic,
      nodeIds: [move.sourceNodeId, move.targetNodeId].filter((nodeId) => nodeId !== ''),
      stuckBefore,
    });
    const { id, views: _views, ...shown } = move;
    running.push({ kind: 'running', signature: `running:${id}`, ...shown });
    if (failedTooLong) {
      const mark = views[IMPORT_VIEW];
      stuck.push({
        kind: 'stuck',
        signature: stuckSignature,
        ...shown,
        quietMs,
        importFailing: true,
        jobName: id.slice(JOB_MOVE.length),
        retries: mark?.retries,
        reason: mark?.lastError,
      });
    } else if (isStuck) {
      stuck.push({ kind: 'stuck', signature: stuckSignature, ...shown, quietMs });
    } else if (stuckBefore) {
      held.add(stuckSignature);
    }
  }

  for (const [id, move] of watch.moves) {
    if (moves.has(id) || finished.has(id)) continue;
    if (!couldNotBeSeen(move, move.atomic ? jobs : markers)) continue;
    moves.set(id, move);
    unseen.add(`running:${id}`);
    unseen.add(`stuck:${id}`);
  }

  const adopted = new Set<string>();
  for (const signature of watch.adopted) {
    const id = signature.slice(signature.indexOf(':') + 1);
    if (listed.has(id) || endedWhileUnwatched(id, report, markers, finished)) continue;
    adopted.add(signature);
    held.add(signature);
  }

  const knownFailed = new Set(report.complete ? [] : watch.knownFailed);
  for (const job of report.failed) {
    knownFailed.add(job.jobName);
    if (watch.knownFailed.has(job.jobName)) continue;
    const wasRunning = watch.moves.has(`${JOB_MOVE}${job.jobName}`);
    const wasWatched = job.listedByNodeIds.some((nodeId) => jobs.seenBefore.has(nodeId));
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

  if (finding.kind === 'running') {
    return `INFO: Slot migration running: ${move}. This entry closes when the migration ends.`;
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
  if (finding.importFailing) {
    const reason = oneLine(finding.reason ?? '');
    const said = reason === '' ? 'The server gave no reason.' : `The server said: "${reason}".`;
    const retried =
      finding.retries === undefined
        ? ''
        : `, and its target has retried it ${finding.retries} time${finding.retries === 1 ? '' : 's'}`;
    return (
      `WARNING: Slot migration stuck: ${move} has kept failing for ${quiet}${retried}. ${said} ` +
      `Check that ${target} can reach ${source} and log in to it, and that ${target} has the ` +
      `memory and the good replicas the import needs. To stop it, run ` +
      `CLUSTER MIGRATION CANCEL ID ${oneLine(finding.jobName ?? '')} on ${target}.`
    );
  }
  if (finding.atomic) {
    const state = finding.phase ? ` (state: ${oneLine(finding.phase)})` : '';
    return (
      `WARNING: Slot migration stuck: ${move} has not changed state or cut its replication ` +
      `backlog for ${quiet}${state}. Check for a save or AOF rewrite running on ${source}, ` +
      `which holds back the snapshot, and for writes to these slots arriving faster than the ` +
      `target takes them, which keep the backlog from draining. ` +
      `To stop it, run CLUSTER CANCELSLOTMIGRATIONS on ${source}. ` +
      `That cancels every migration that node is the source of, not only this one.`
    );
  }
  return (
    `WARNING: Slot migration stuck: ${move} has had the same MIGRATING or IMPORTING markers ` +
    `for ${quiet}. The tool that was moving the slots may have stopped. Finish the move with ` +
    `that tool, or repair the open slots with the cluster fix command of valkey-cli or redis-cli.`
  );
}
