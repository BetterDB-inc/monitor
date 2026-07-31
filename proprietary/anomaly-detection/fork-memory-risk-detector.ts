/**
 * Fork-based-persistence copy-on-write (COW) memory-risk detection
 * (valkey-io/valkey#3609, the DollySave / forkless-save motivation): BGSAVE and
 * AOF rewrite fork the server; the child shares the dataset's pages copy-on-write.
 * Writes arriving DURING the save dirty those pages, so the process RSS grows
 * toward `used_memory + <bytes written while the child runs>`. Under Linux
 * memory overcommit, if that projected peak exceeds available RAM the OOM killer
 * can terminate the whole server mid-save. This is distinct from a STUCK child
 * (see detectPersistenceStall, which watches frozen progress / an elapsed
 * ceiling) — here the save may be progressing perfectly while RSS climbs toward
 * an OOM.
 *
 * Two advisories, plus an optional slow-fork note:
 *   (a) LIVE COW-OOM — while a save is in progress, project the peak RSS as
 *       `used_memory_rss + current_cow_size` (the live COW growth) and compare
 *       it against total_system_memory. WARNING >= 80%, CRITICAL >= 90%. This is
 *       the imminent-danger path.
 *   (b) PROJECTED fork-OOM — while NO save is in progress but write pressure is
 *       high, estimate the NEXT save's peak as `used_memory_rss +
 *       max(rdb_last_cow_size, aof_last_cow_size)` (the last save's COW is a good
 *       estimator of the next, and either an RDB save or an AOF rewrite may fork
 *       next, so an AOF-only deployment is covered too). WARNING only, and only
 *       when there is a real basis (a positive last COW and total_system_memory
 *       known).
 *
 * The evaluator is re-entrant on an external per-connection state object (the
 * anomaly service holds one per connection) and follows the client-saturation /
 * COB hysteresis contract: it returns a finding only when the risk level
 * ESCALATES above the last ACKNOWLEDGED level, keeps returning that finding
 * until the caller acknowledges a successful emit (so a failed emit retries next
 * poll), and re-arms — dropping the acknowledged level — as the risk recedes.
 * vm.overcommit_memory is not exposed by INFO, so the advisory always flags it
 * as a host-side thing to verify rather than asserting it is misconfigured.
 */

/** Projected-peak fraction of total system memory at which the LIVE path warns. */
export const FORK_OOM_WARN_FRACTION = 0.8;
/** Projected-peak fraction at which the LIVE path escalates to critical. */
export const FORK_OOM_CRIT_FRACTION = 0.9;
/** latest_fork_usec above this (0.5s) is a slow fork worth noting (large dataset / THP). */
export const SLOW_FORK_USEC = 500_000;
/**
 * Write-pressure gate for the PROJECTED (idle) path — the next save is only
 * "likely to be triggered soon under load" under a genuine CURRENT write rate.
 * Keyed on the per-poll RATE of rdb_changes_since_last_save (writes/sec, derived
 * by the caller from the counter delta), for two reasons: reads never increment
 * that counter (so ops/sec, which includes reads, would false-fire on a
 * read-heavy instance), and a rate CLEARS when writes stop — the raw cumulative
 * counter only resets on an RDB save, so on an AOF-only (or save-disabled)
 * deployment it grows for the process lifetime and would pin the warning on a
 * stale signal forever.
 */
export const FORK_PROJECT_WRITE_RATE_PER_SEC = 1_000;

export type ForkRiskLevel = 'none' | 'warning' | 'critical';
export type ForkRiskKind = 'live-cow-oom' | 'projected-fork-oom';

export interface ForkMemoryInput {
  bgsaveInProgress: boolean;
  aofRewriteInProgress: boolean;
  currentCowSize: number | null;
  rdbLastCowSize: number | null;
  aofLastCowSize: number | null;
  latestForkUsec: number | null;
  usedMemory: number;
  usedMemoryRss: number | null;
  totalSystemMemory: number | null;
  /** Current write rate (writes/sec) from the per-poll delta of rdb_changes_since_last_save. */
  writeRatePerSec: number | null;
  timestamp: number;
}

export interface ForkMemoryState {
  ackedLevel: ForkRiskLevel;
  /** Kind of the acknowledged finding, so a live risk isn't masked by a projected one. */
  ackedKind: ForkRiskKind;
}

export interface ForkMemoryFinding {
  level: 'warning' | 'critical';
  kind: ForkRiskKind;
  projectedFraction: number;
  message: string;
  timestamp: number;
}

/**
 * Combined severity, so hysteresis compares BOTH the level and the kind. The
 * live-cow-oom (imminent, save-in-progress) path outranks a speculative
 * projected-fork-oom at the SAME level — otherwise a projected WARNING that was
 * already acknowledged would suppress the live WARNING once a save actually
 * starts, hiding the imminent-danger alert unless it reached CRITICAL.
 */
function severityScore(level: ForkRiskLevel, kind: ForkRiskKind): number {
  if (level === 'none') return 0;
  const levelPart = level === 'critical' ? 2 : 1;
  const kindPart = kind === 'live-cow-oom' ? 1 : 0;
  return levelPart * 10 + kindPart;
}

export function createForkMemoryState(): ForkMemoryState {
  return { ackedLevel: 'none', ackedKind: 'projected-fork-oom' };
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)}GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)}MB`;
}

const OVERCOMMIT_REMEDY =
  'Ensure vm.overcommit_memory=1 (not readable from INFO — verify on the host) and enough RAM ' +
  'headroom, reduce the write burst during saves, or consider a replica-offloaded / forkless save.';

function saveLabel(input: ForkMemoryInput): string {
  if (input.bgsaveInProgress && input.aofRewriteInProgress) {
    return 'BGSAVE + AOF rewrite';
  }
  if (input.aofRewriteInProgress) {
    return 'AOF rewrite';
  }
  return 'BGSAVE';
}

function slowForkNote(latestForkUsec: number | null): string {
  if (latestForkUsec !== null && latestForkUsec > SLOW_FORK_USEC) {
    return (
      ` The last fork itself took ${(latestForkUsec / 1_000_000).toFixed(2)}s ` +
      `(latest_fork_usec) — a slow fork points to a large dataset or transparent huge pages (THP), ` +
      `which also stalls the main thread during the fork.`
    );
  }
  return '';
}

interface Assessment {
  level: ForkRiskLevel;
  kind: ForkRiskKind;
  projectedFraction: number;
  message: string;
}

const NONE_LIVE: Assessment = {
  level: 'none',
  kind: 'live-cow-oom',
  projectedFraction: 0,
  message: '',
};
const NONE_PROJECTED: Assessment = {
  level: 'none',
  kind: 'projected-fork-oom',
  projectedFraction: 0,
  message: '',
};

function assess(input: ForkMemoryInput): Assessment {
  const saveInProgress = input.bgsaveInProgress || input.aofRewriteInProgress;

  // total_system_memory is the denominator for both paths — without it the
  // OOM risk simply cannot be assessed (INFO memory can report 0/absent).
  const systemMemory = input.totalSystemMemory;
  const systemMemoryKnown = systemMemory !== null && systemMemory > 0;

  if (saveInProgress) {
    if (!systemMemoryKnown) {
      return NONE_LIVE;
    }
    // used_memory_rss already reflects the COW growth so far; add current_cow_size
    // as the live head-room the child is still eating. Fall back to used_memory
    // when RSS is unavailable.
    const basis = input.usedMemoryRss ?? input.usedMemory;
    const cow = input.currentCowSize ?? 0;
    const projectedPeak = basis + cow;
    const fraction = projectedPeak / (systemMemory as number);
    const level: ForkRiskLevel =
      fraction >= FORK_OOM_CRIT_FRACTION
        ? 'critical'
        : fraction >= FORK_OOM_WARN_FRACTION
          ? 'warning'
          : 'none';
    if (level === 'none') {
      return NONE_LIVE;
    }
    const pct = (fraction * 100).toFixed(1);
    const message =
      `${saveLabel(input)} in progress: projected peak RSS ~${formatBytes(projectedPeak)} ` +
      `(current RSS ${formatBytes(basis)} + COW ${formatBytes(cow)}) is ${pct}% of total system ` +
      `memory (${formatBytes(systemMemory as number)}). Copy-on-write amplification from writes ` +
      `during the save can push RSS past available RAM and let the OOM killer terminate the ` +
      `server mid-save (valkey#3609). ${OVERCOMMIT_REMEDY}${slowForkNote(input.latestForkUsec)}`;
    return { level, kind: 'live-cow-oom', projectedFraction: fraction, message };
  }

  // No save running — project the NEXT fork from the last save's COW footprint.
  // Only meaningful with a real basis and under genuine write pressure.
  if (!systemMemoryKnown) {
    return NONE_PROJECTED;
  }
  // Either persistence type may fork next, so estimate from the larger of the
  // two last-save COW footprints — this keeps an AOF-only deployment (no RDB
  // COW history) covered.
  const lastCow = Math.max(input.rdbLastCowSize ?? 0, input.aofLastCowSize ?? 0);
  if (lastCow <= 0) {
    return NONE_PROJECTED;
  }
  // Current write rate (writes/sec). Reads never increment the source counter,
  // and unlike the raw cumulative counter this falls back to ~0 when writes stop
  // — so the warning re-arms on a now-idle server instead of staying pinned.
  const highWrite =
    input.writeRatePerSec !== null && input.writeRatePerSec >= FORK_PROJECT_WRITE_RATE_PER_SEC;
  if (!highWrite) {
    return NONE_PROJECTED;
  }
  const basis = input.usedMemoryRss ?? input.usedMemory;
  const projectedPeak = basis + lastCow;
  const fraction = projectedPeak / (systemMemory as number);
  if (fraction < FORK_OOM_WARN_FRACTION) {
    return NONE_PROJECTED;
  }
  const pct = (fraction * 100).toFixed(1);
  const pressureText = `write rate ~${Math.round(input.writeRatePerSec as number).toLocaleString()} writes/s`;
  const message =
    `No save in progress but write pressure is high (${pressureText}): the next BGSAVE / AOF ` +
    `rewrite fork is projected to reach ~${formatBytes(projectedPeak)} RSS (current RSS ` +
    `${formatBytes(basis)} + last-save COW ${formatBytes(lastCow)}) = ${pct}% of total system ` +
    `memory (${formatBytes(systemMemory as number)}), past safe headroom — risks a copy-on-write ` +
    `OOM kill when a save is next triggered (valkey#3609). ${OVERCOMMIT_REMEDY}` +
    `${slowForkNote(input.latestForkUsec)}`;
  // PROJECTED path is a heads-up: WARNING only, never critical.
  return { level: 'warning', kind: 'projected-fork-oom', projectedFraction: fraction, message };
}

/**
 * Evaluates one poll's INFO snapshot against the connection's hysteresis state
 * and returns a finding to emit, or null. Mutates `state` only to RE-ARM on a
 * drop; the acknowledged level is advanced by `acknowledgeForkMemoryFinding`
 * after a successful emit, so an un-acknowledged (failed) emit is re-returned on
 * the next poll.
 */
export function evaluateForkMemoryRisk(
  state: ForkMemoryState,
  input: ForkMemoryInput,
): ForkMemoryFinding | null {
  const assessment = assess(input);
  const currentScore = severityScore(assessment.level, assessment.kind);

  // De-escalation re-arms immediately: a drop to a lower combined severity —
  // whether a level drop OR a live->projected kind drop at the same level —
  // lowers the acknowledged severity so a later rise escalates and alerts again.
  if (currentScore < severityScore(state.ackedLevel, state.ackedKind)) {
    state.ackedLevel = assessment.level;
    state.ackedKind = assessment.kind;
  }

  const escalated = currentScore > severityScore(state.ackedLevel, state.ackedKind);
  if (!escalated) {
    return null;
  }

  return {
    level: assessment.level === 'critical' ? 'critical' : 'warning',
    kind: assessment.kind,
    projectedFraction: assessment.projectedFraction,
    message: assessment.message,
    timestamp: input.timestamp,
  };
}

/**
 * Advances the acknowledged level after a finding was successfully emitted, so
 * the same level does not re-alert every poll while the condition persists.
 */
export function acknowledgeForkMemoryFinding(
  state: ForkMemoryState,
  finding: ForkMemoryFinding,
): void {
  state.ackedLevel = finding.level;
  state.ackedKind = finding.kind;
}
