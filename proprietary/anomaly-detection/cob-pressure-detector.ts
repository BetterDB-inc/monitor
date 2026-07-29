/**
 * Replication output-buffer (COB) pressure detection (valkey-io/valkey#3963):
 * during full sync on a busy primary, a replica's client output buffer can
 * overflow `client-output-buffer-limit slave` before the sync completes. The
 * server drops the replica, which reconnects and full-syncs again — a loop
 * where the primary burns CPU/network and the replica never becomes
 * functional. The same pressure builds in steady state when a replica can't
 * keep up. This module surfaces the buffer-vs-limit signal BEFORE the forced
 * disconnect, plus the confirmation signal once an overflow already forced a
 * resync.
 *
 * The evaluator is re-entrant on an external per-connection state object (the
 * anomaly service holds one per connection). Ratio findings follow the
 * client-saturation hysteresis contract: emitted on escalation only, kept
 * pending until the caller acknowledges a successful emit (so a failed emit
 * retries next poll), re-armed when the buffer drains below the warning
 * threshold. Resync-loop findings are event-driven (per sync_full delta);
 * acknowledging one closes a connection-wide re-emission gate for
 * `COB_RESYNC_REFIRE_MS` so a sustained loop alerts once, not once per poll.
 */

export const COB_WARN_RATIO = 0.6;
export const COB_CRIT_RATIO = 0.9;
/** How recently a replica must have been pressured for a sync_full increment to read as an overflow. */
export const COB_PRESSURE_MEMORY_MS = 5 * 60_000;
/** A sustained loop keeps satisfying the resync signature every poll — re-emit at most this often. */
export const COB_RESYNC_REFIRE_MS = 5 * 60_000;

const AGGREGATE_KEY = '(aggregate)';
const SYNC_TIMES_LIMIT = 20;

export interface SlaveOutputBufferLimit {
  hardBytes: number;
  softBytes: number;
  softSeconds: number;
}

export interface ReplicaObservation {
  addr: string;
  omem: number;
}

export type CobLevel = 'none' | 'warning' | 'critical';

interface ReplicaPressureState {
  ackedLevel: CobLevel;
  softBreachSince: number | null;
  lastPressuredAt: number | null;
  lastSeenAt: number;
}

export interface CobConnectionState {
  replicas: Map<string, ReplicaPressureState>;
  syncFullTimes: number[];
  /** connected_slaves from the previous evaluation, for explaining sync_full increments. */
  lastConnectedSlaves: number | null;
  /**
   * Last acknowledged resync-loop emit. Deliberately connection-global, not
   * per-addr: a loop's reconnects arrive on fresh ephemeral ports, so an
   * addr-keyed gate would never suppress anything.
   */
  resyncFiredAt: number | null;
}

export interface CobEvaluationInput {
  /** Parsed CLIENT LIST TYPE replica observations, or null when unavailable (denied). */
  replicas: ReplicaObservation[] | null;
  /** Parsed slave limit triplet, or null when CONFIG GET was unavailable. */
  limit: SlaveOutputBufferLimit | null;
  /** INFO memory mem_clients_slaves aggregate, for the reduced-fidelity fallback. */
  memClientsSlaves: number | null;
  connectedSlaves: number;
  /** sync_full increments since the previous poll. */
  syncFullDelta: number;
  timestamp: number;
}

export type CobFindingKind = 'hard-approach' | 'soft-sustained' | 'aggregate' | 'resync-loop';

export interface CobPressureFinding {
  replicaAddr: string | null;
  ratio: number | null;
  level: 'warning' | 'critical';
  kind: CobFindingKind;
  message: string;
  timestamp: number;
}

const LEVEL_RANK: Record<CobLevel, number> = { none: 0, warning: 1, critical: 2 };

export function createCobConnectionState(): CobConnectionState {
  return {
    replicas: new Map(),
    syncFullTimes: [],
    lastConnectedSlaves: null,
    resyncFiredAt: null,
  };
}

/**
 * Extracts the `slave <hard> <soft> <secs>` triplet from the full multi-class
 * CONFIG GET value (`normal 0 0 0 slave 268435456 67108864 60 pubsub ...`).
 * Accepts the `replica` alias for the class name.
 */
export function parseSlaveOutputBufferLimit(raw: string | null): SlaveOutputBufferLimit | null {
  if (raw === null || raw === '') {
    return null;
  }
  const tokens = raw.trim().split(/\s+/);
  for (let i = 0; i < tokens.length - 3; i += 1) {
    const isSlaveClass = tokens[i] === 'slave' || tokens[i] === 'replica';
    if (isSlaveClass === false) {
      continue;
    }
    const hardBytes = Number(tokens[i + 1]);
    const softBytes = Number(tokens[i + 2]);
    const softSeconds = Number(tokens[i + 3]);
    const allFinite =
      Number.isFinite(hardBytes) && Number.isFinite(softBytes) && Number.isFinite(softSeconds);
    if (allFinite === false) {
      return null;
    }
    return { hardBytes, softBytes, softSeconds };
  }
  return null;
}

function isUnlimited(limit: SlaveOutputBufferLimit): boolean {
  return limit.hardBytes === 0 && limit.softBytes === 0;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${Math.round(mb)}MB`;
}

const REMEDY = 'Raise the limit or reduce the write burst.';

function getReplicaState(
  state: CobConnectionState,
  addr: string,
  timestamp: number,
): ReplicaPressureState {
  const existing = state.replicas.get(addr);
  if (existing !== undefined) {
    existing.lastSeenAt = timestamp;
    return existing;
  }
  const created: ReplicaPressureState = {
    ackedLevel: 'none',
    softBreachSince: null,
    lastPressuredAt: null,
    lastSeenAt: timestamp,
  };
  state.replicas.set(addr, created);
  return created;
}

interface RatioAssessment {
  level: CobLevel;
  kind: CobFindingKind;
  ratio: number;
  /**
   * True whenever the replica is under buffer pressure, including a soft
   * breach still inside its grace window: the server disconnects exactly at
   * grace expiry, so pressure memory for the sync_full coincidence must start
   * at the breach, not at the soft-sustained alert.
   */
  pressured: boolean;
}

function assessRatio(
  omem: number,
  limit: SlaveOutputBufferLimit,
  replicaState: ReplicaPressureState,
  timestamp: number,
): RatioAssessment {
  const hardRatio = limit.hardBytes > 0 ? omem / limit.hardBytes : 0;
  if (limit.hardBytes > 0 && hardRatio >= COB_CRIT_RATIO) {
    return { level: 'critical', kind: 'hard-approach', ratio: hardRatio, pressured: true };
  }
  if (limit.hardBytes > 0 && hardRatio >= COB_WARN_RATIO) {
    return { level: 'warning', kind: 'hard-approach', ratio: hardRatio, pressured: true };
  }

  // softSeconds 0 disables the soft limit entirely, so a breach of the byte
  // threshold alone carries no disconnect risk and must not count as pressure.
  const softThreshold = limit.softBytes * COB_WARN_RATIO;
  if (limit.softBytes > 0 && limit.softSeconds > 0 && omem >= softThreshold) {
    if (replicaState.softBreachSince === null) {
      replicaState.softBreachSince = timestamp;
    }
    const sustainedMs = timestamp - replicaState.softBreachSince;
    if (sustainedMs > limit.softSeconds * 1000) {
      // The soft limit is the one at play here — a hard-limit fraction would
      // read misleadingly low (soft is typically far below hard).
      return {
        level: 'warning',
        kind: 'soft-sustained',
        ratio: omem / limit.softBytes,
        pressured: true,
      };
    }
    return { level: 'none', kind: 'hard-approach', ratio: hardRatio, pressured: true };
  }
  replicaState.softBreachSince = null;

  return { level: 'none', kind: 'hard-approach', ratio: hardRatio, pressured: false };
}

function buildRatioMessage(
  addr: string,
  omem: number,
  assessment: RatioAssessment,
  limit: SlaveOutputBufferLimit,
): string {
  if (assessment.kind === 'soft-sustained') {
    return (
      `Replica ${addr} output buffer (${formatBytes(omem)}) has stayed above ` +
      `${Math.round(COB_WARN_RATIO * 100)}% of the client-output-buffer-limit slave soft limit ` +
      `(${formatBytes(limit.softBytes)}) for over ${limit.softSeconds}s — early warning: if it ` +
      `crosses the soft limit and stays there for ${limit.softSeconds}s, the server forces a ` +
      `disconnect + full resync (valkey#3963). ${REMEDY}`
    );
  }
  const pct = Math.round(assessment.ratio * 100);
  return (
    `Replica ${addr} output buffer at ${pct}% of the client-output-buffer-limit slave hard ` +
    `limit (${formatBytes(omem)} / ${formatBytes(limit.hardBytes)}) — approaching a forced ` +
    `disconnect + full resync (valkey#3963). ${REMEDY}`
  );
}

/**
 * Folds one poll's observations into the connection state and returns every
 * finding the caller should emit. Mutates `state`. Ratio findings keep being
 * returned until `acknowledgeCobFinding` is called for them.
 */
export function evaluateCobPressure(
  state: CobConnectionState,
  input: CobEvaluationInput,
): CobPressureFinding[] {
  const findings: CobPressureFinding[] = [];
  const { timestamp } = input;

  const previousConnectedSlaves = state.lastConnectedSlaves;
  state.lastConnectedSlaves = input.connectedSlaves;

  const previouslyPressured = [...state.replicas.entries()]
    .filter(([, replicaState]) => {
      return (
        replicaState.lastPressuredAt !== null &&
        timestamp - replicaState.lastPressuredAt <= COB_PRESSURE_MEMORY_MS
      );
    })
    .sort((a, b) => {
      return (b[1].lastPressuredAt ?? 0) - (a[1].lastPressuredAt ?? 0);
    });

  const limit = input.limit;
  const ratioAlertsAvailable = limit !== null && isUnlimited(limit) === false;

  if (ratioAlertsAvailable && limit !== null) {
    if (input.replicas !== null) {
      // Per-replica visibility is back — the degraded-mode aggregate entry is
      // superseded and must not linger as pressure memory.
      state.replicas.delete(AGGREGATE_KEY);
      for (const replica of input.replicas) {
        const replicaState = getReplicaState(state, replica.addr, timestamp);
        const assessment = assessRatio(replica.omem, limit, replicaState, timestamp);
        applyLevel(
          findings,
          replicaState,
          assessment,
          timestamp,
          () => {
            return buildRatioMessage(replica.addr, replica.omem, assessment, limit);
          },
          replica.addr,
        );
      }
    } else if (input.memClientsSlaves !== null && input.connectedSlaves > 0) {
      const combined = limit.hardBytes * input.connectedSlaves;
      const ratio = combined > 0 ? input.memClientsSlaves / combined : 0;
      const level: CobLevel =
        ratio >= COB_CRIT_RATIO ? 'critical' : ratio >= COB_WARN_RATIO ? 'warning' : 'none';
      const replicaState = getReplicaState(state, AGGREGATE_KEY, timestamp);
      const assessment: RatioAssessment = {
        level,
        kind: 'aggregate',
        ratio,
        pressured: level !== 'none',
      };
      applyLevel(
        findings,
        replicaState,
        assessment,
        timestamp,
        () => {
          const pct = Math.round(ratio * 100);
          return (
            `Replica output buffers at ${pct}% of the combined client-output-buffer-limit slave ` +
            `hard limit (mem_clients_slaves aggregate; reduced fidelity — CLIENT LIST ` +
            `unavailable) (valkey#3963). ${REMEDY}`
          );
        },
        AGGREGATE_KEY,
      );
    }
  }

  if (input.syncFullDelta > 0) {
    if (ratioAlertsAvailable) {
      // sync_full is a global counter, so a pressured replica alone is not
      // enough — another replica joining or restarting also increments it.
      // The overflow signature is a pressured replica whose connection
      // VANISHED from CLIENT LIST: an overflow disconnect kills the
      // connection, and a reconnect arrives on a new ephemeral port (a new
      // addr), so the pressured addr disappears either way. A replica still
      // present on the same connection was never dropped — even if its
      // buffer drained, that is normal recovery and someone else's sync must
      // not be pinned on it. With CLIENT LIST unavailable (aggregate mode)
      // presence can't be verified — reduced fidelity accepted.
      const overflowCandidates = previouslyPressured.filter(([addr, replicaState]) => {
        if (addr === AGGREGATE_KEY) {
          // Aggregate pressure is only meaningful while CLIENT LIST is still
          // unavailable; once per-replica visibility resumes, the stale
          // aggregate entry must not arm the coincidence.
          return input.replicas === null;
        }
        if (input.replicas === null) {
          return true;
        }
        return replicaState.lastSeenAt !== timestamp;
      });
      if (overflowCandidates.length > 0 && resyncRefireOpen(state, timestamp)) {
        const [addr] = overflowCandidates[0];
        findings.push({
          replicaAddr: addr === AGGREGATE_KEY ? null : addr,
          ratio: null,
          level: 'critical',
          kind: 'resync-loop',
          message:
            `Replica ${addr === AGGREGATE_KEY ? '(aggregate)' : addr} was dropped after ` +
            `output-buffer pressure — sync_full incremented and a full-resync loop is likely ` +
            `live (valkey#3963). ${REMEDY}`,
          timestamp,
        });
      }
    } else {
      // Without ratio visibility there is no buffer-pressure correlation, and
      // `slave 0 0 0` is a recommended mitigation on large primaries — so
      // rolling restarts and replicas joining must not read as a loop. A
      // sync_full increment is explained (and not counted) when connected
      // replicas grew by as much in the same interval: joins grow the count,
      // while a loop churns without net growth.
      const replicaGrowth =
        previousConnectedSlaves === null
          ? 0
          : Math.max(0, input.connectedSlaves - previousConnectedSlaves);
      const unexplained = Math.max(0, input.syncFullDelta - replicaGrowth);
      // One entry per increment: a burst where sync_full jumps by 2+ inside a
      // single poll interval is already a loop and must reach the threshold.
      const increments = Math.min(unexplained, SYNC_TIMES_LIMIT);
      for (let i = 0; i < increments; i += 1) {
        state.syncFullTimes.push(timestamp);
      }
      while (state.syncFullTimes.length > SYNC_TIMES_LIMIT) {
        state.syncFullTimes.shift();
      }
      const recent = state.syncFullTimes.filter((t) => {
        return timestamp - t <= COB_PRESSURE_MEMORY_MS;
      });
      state.syncFullTimes = recent;
      if (recent.length >= 2 && resyncRefireOpen(state, timestamp)) {
        const spanSeconds = Math.round((timestamp - recent[0]) / 1000);
        const limitContext =
          limit === null
            ? `client-output-buffer-limit slave could not be read (CONFIG GET denied), so ` +
              `buffer pressure could not be correlated — verify the limit and replica health directly`
            : `an unlimited client-output-buffer-limit slave — a resync loop with unlimited COB ` +
              `indicates memory pressure or an unstable replica`;
        findings.push({
          replicaAddr: null,
          ratio: null,
          level: 'critical',
          kind: 'resync-loop',
          message:
            `${recent.length} full syncs in ${spanSeconds}s without matching replica-count ` +
            `growth; ${limitContext} (valkey#3963).`,
          timestamp,
        });
      }
    }
  }

  for (const [addr, replicaState] of state.replicas) {
    const seenThisPoll = replicaState.lastSeenAt === timestamp;
    if (seenThisPoll) {
      continue;
    }
    if (timestamp - replicaState.lastSeenAt > COB_PRESSURE_MEMORY_MS) {
      state.replicas.delete(addr);
    }
  }

  return findings;
}

function resyncRefireOpen(state: CobConnectionState, timestamp: number): boolean {
  if (state.resyncFiredAt === null) {
    return true;
  }
  return timestamp - state.resyncFiredAt > COB_RESYNC_REFIRE_MS;
}

function applyLevel(
  findings: CobPressureFinding[],
  replicaState: ReplicaPressureState,
  assessment: RatioAssessment,
  timestamp: number,
  buildMessage: () => string,
  addr: string,
): void {
  if (assessment.pressured) {
    replicaState.lastPressuredAt = timestamp;
  } else {
    // An observed recovery clears pressure memory: a replica seen healthy and
    // then disconnecting (maintenance, network) is not the overflow signature,
    // and must not turn an unrelated sync_full into a resync-loop CRITICAL.
    replicaState.lastPressuredAt = null;
  }

  const escalated = LEVEL_RANK[assessment.level] > LEVEL_RANK[replicaState.ackedLevel];
  if (escalated) {
    findings.push({
      replicaAddr: addr === AGGREGATE_KEY ? null : addr,
      ratio: assessment.ratio,
      level: assessment.level === 'critical' ? 'critical' : 'warning',
      kind: assessment.kind,
      message: buildMessage(),
      timestamp,
    });
    return;
  }

  if (LEVEL_RANK[assessment.level] < LEVEL_RANK[replicaState.ackedLevel]) {
    replicaState.ackedLevel = assessment.level;
  }
}

/**
 * Advances the stored hysteresis level after a ratio finding was successfully
 * emitted. For resync-loop findings it records the fire time instead, opening
 * the re-emission gate only after `COB_RESYNC_REFIRE_MS` — a sustained loop
 * keeps satisfying the signature every poll and must not emit a fresh
 * CRITICAL each time.
 */
export function acknowledgeCobFinding(
  state: CobConnectionState,
  finding: CobPressureFinding,
): void {
  if (finding.kind === 'resync-loop') {
    state.resyncFiredAt = finding.timestamp;
    return;
  }
  const addr = finding.replicaAddr ?? AGGREGATE_KEY;
  const replicaState = state.replicas.get(addr);
  if (replicaState === undefined) {
    return;
  }
  replicaState.ackedLevel = finding.level;
}
