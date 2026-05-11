import { Inject, Injectable } from '@nestjs/common';
import {
  StoragePort,
  StoredCaptureSession,
  StoredSlowLogEntry,
} from '../common/interfaces/storage-port.interface';
import { ParsedMonitorLine, parseMonitorLine } from './monitor-line.parser';

/** Baseline window selector. `same-hour-last-week` shifts the window to the same hour-of-day 7 days ago. */
export type BaselineWindow = '6h' | '24h' | '7d' | 'same-hour-last-week';

const SCRIPTED_VERBS = new Set(['EVAL', 'EVALSHA', 'FCALL', 'FCALL_RO']);

const HOT_KEY_TOP_K = 50;

export interface CrossReferenceInput {
  sessionId: string;
  baseline: BaselineWindow;
}

export interface NewShape {
  shape: string;
  cmd: string;
  arity: number | null;
  scriptSha: string | null;
  countInCapture: number;
}

export interface HotKey {
  key: string;
  countInCapture: number;
  countInBaseline: number;
  rankInCapture: number;
  rankInBaseline: number | null;
}

export interface HotKeyDelta {
  newInTopK: HotKey[];
  rankChanges: HotKey[];
}

export interface SlowlogRegression {
  cmd: string;
  shape: string;
  slowlogCountInSession: number;
  observedRatePerSec: number;
  baselineRatePerSec: number;
  baselineP95RatePerSec: number;
}

export interface AclDeltas {
  /** Audit-trail entries persisted with `captured_at` inside the session window. Empty when the audit module is not in use. */
  auditEntriesInWindow: number;
  /**
   * INFO counter snapshots are not yet captured at session start/end. v1 surfaces a
   * placeholder so the UI shape is final; PR 9-era pre-flight INFO + future session-
   * boundary snapshots will populate these.
   */
  counters: {
    aclAccessDeniedAuthDelta: number | null;
    rejectedConnectionsDelta: number | null;
  };
}

export interface CrossReferenceResult {
  sessionId: string;
  baseline: {
    window: BaselineWindow;
    startTs: number;
    endTs: number;
  };
  session: {
    startTs: number;
    endTs: number;
    capturedLineCount: number;
  };
  newShapes: NewShape[];
  hotKeyDelta: HotKeyDelta;
  slowlogRegressions: SlowlogRegression[];
  aclDeltas: AclDeltas;
}

/**
 * The differentiator. Diffs a completed capture against the connection's
 * recent history along four axes — new command shapes, hot-key delta,
 * slowlog regressions, and ACL/audit deltas — using only data already
 * persisted by the rest of the platform (slowlog, commandlog, client
 * snapshots, audit trail).
 *
 * The engine is a single class with one public method so it can be reused
 * for the Pro+ capture-vs-capture diff in PR 23 by swapping the baseline
 * source: instead of (session vs slowlog/commandlog history), feed it
 * (sessionA shapes vs sessionB shapes).
 */
@Injectable()
export class CrossReferenceEngine {
  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
  ) {}

  async compute(input: CrossReferenceInput): Promise<CrossReferenceResult> {
    const session = await this.storage.getCaptureSession(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} not found`);
    }

    const sessionStartMs = session.startedAt;
    const sessionEndMs = session.endedAt ?? Date.now();

    const { baselineStartMs, baselineEndMs } = computeBaselineRange(
      input.baseline,
      sessionStartMs,
    );

    const capturedLines = await this.parseCapturedLines(input.sessionId);

    const [slowlogBaseline, slowlogSession, baselineShapes, baselineKeyCounts, auditEntries] =
      await Promise.all([
        this.storage.getSlowLogEntries({
          connectionId: session.connectionId,
          startTime: Math.floor(baselineStartMs / 1000),
          endTime: Math.floor(baselineEndMs / 1000),
          limit: 100_000,
        }),
        this.storage.getSlowLogEntries({
          connectionId: session.connectionId,
          startTime: Math.floor(sessionStartMs / 1000),
          endTime: Math.floor(sessionEndMs / 1000),
          limit: 100_000,
        }),
        this.collectBaselineShapes(session, baselineStartMs, baselineEndMs),
        this.collectBaselineKeyCounts(session.connectionId, baselineStartMs, baselineEndMs),
        this.storage.getAclEntries({
          connectionId: session.connectionId,
          startTime: Math.floor(sessionStartMs / 1000),
          endTime: Math.floor(sessionEndMs / 1000),
          limit: 10_000,
        }),
      ]);

    const newShapes = computeNewShapes(capturedLines, baselineShapes);
    const hotKeyDelta = computeHotKeyDelta(capturedLines, baselineKeyCounts);
    const slowlogRegressions = computeSlowlogRegressions(
      capturedLines,
      slowlogBaseline,
      slowlogSession,
      baselineStartMs,
      baselineEndMs,
      sessionStartMs,
      sessionEndMs,
    );

    return {
      sessionId: input.sessionId,
      baseline: {
        window: input.baseline,
        startTs: baselineStartMs,
        endTs: baselineEndMs,
      },
      session: {
        startTs: sessionStartMs,
        endTs: sessionEndMs,
        capturedLineCount: capturedLines.length,
      },
      newShapes,
      hotKeyDelta,
      slowlogRegressions,
      aclDeltas: {
        auditEntriesInWindow: auditEntries.length,
        counters: {
          aclAccessDeniedAuthDelta: null,
          rejectedConnectionsDelta: null,
        },
      },
    };
  }

  private async parseCapturedLines(sessionId: string): Promise<ParsedMonitorLine[]> {
    const chunks = await this.storage.getCaptureChunks(sessionId);
    const lines: ParsedMonitorLine[] = [];
    for (const chunk of chunks) {
      const text = chunk.bytes.toString('utf-8');
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        const parsed = parseMonitorLine(raw);
        if (parsed) lines.push(parsed);
      }
    }
    return lines;
  }

  /**
   * Collect every shape seen in the baseline window across all three sources.
   * Shapes use the same encoding as captured lines (see {@link shapeOf}) so set
   * membership works directly.
   */
  private async collectBaselineShapes(
    session: StoredCaptureSession,
    startMs: number,
    endMs: number,
  ): Promise<Set<string>> {
    const shapes = new Set<string>();

    const [slowlog, commandlog, clientSnapshots] = await Promise.all([
      this.storage.getSlowLogEntries({
        connectionId: session.connectionId,
        startTime: Math.floor(startMs / 1000),
        endTime: Math.floor(endMs / 1000),
        limit: 100_000,
      }),
      this.storage.getCommandLogEntries({
        connectionId: session.connectionId,
        startTime: Math.floor(startMs / 1000),
        endTime: Math.floor(endMs / 1000),
        limit: 100_000,
      }),
      this.storage.getClientSnapshots({
        connectionId: session.connectionId,
        startTime: startMs,
        endTime: endMs,
        limit: 100_000,
      }),
    ]);

    for (const e of slowlog) shapes.add(shapeOfStringArray(e.command));
    for (const e of commandlog) shapes.add(shapeOfStringArray(e.command));
    // client-snapshot.cmd is a single verb — represent as `VERB:*` so that any
    // arity from the capture side considers the verb "seen".
    for (const c of clientSnapshots) {
      if (c.cmd) shapes.add(`${c.cmd.toUpperCase()}:*`);
    }

    return shapes;
  }

  private async collectBaselineKeyCounts(
    connectionId: string,
    startMs: number,
    endMs: number,
  ): Promise<Map<string, number>> {
    const entries = await this.storage.getSlowLogEntries({
      connectionId,
      startTime: Math.floor(startMs / 1000),
      endTime: Math.floor(endMs / 1000),
      limit: 100_000,
    });
    const counts = new Map<string, number>();
    for (const e of entries) {
      const key = firstArgOf(e.command);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so the spec can fixture-test them in isolation)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function computeBaselineRange(
  window: BaselineWindow,
  sessionStartMs: number,
): { baselineStartMs: number; baselineEndMs: number } {
  switch (window) {
    case '6h':
      return { baselineStartMs: sessionStartMs - 6 * HOUR_MS, baselineEndMs: sessionStartMs };
    case '24h':
      return { baselineStartMs: sessionStartMs - DAY_MS, baselineEndMs: sessionStartMs };
    case '7d':
      return { baselineStartMs: sessionStartMs - 7 * DAY_MS, baselineEndMs: sessionStartMs };
    case 'same-hour-last-week':
      return {
        baselineStartMs: sessionStartMs - WEEK_MS,
        baselineEndMs: sessionStartMs - WEEK_MS + HOUR_MS,
      };
  }
}

/**
 * Shape encoding rules:
 *  - Scripted (EVAL/EVALSHA/FCALL/FCALL_RO): `${verb}:${sha-or-name}`. arity is
 *    semantically meaningless for scripts.
 *  - All others: `${verb}:${arity}` where arity is args.length (zero for PING).
 *  - Verbs are uppercased everywhere so the comparison is case-insensitive.
 */
export function shapeOf(line: ParsedMonitorLine): { shape: string; cmd: string; arity: number | null; scriptSha: string | null } {
  const cmd = line.cmd.toUpperCase();
  if (SCRIPTED_VERBS.has(cmd)) {
    const sha = line.args[0] ?? '<unknown>';
    return { shape: `${cmd}:${sha}`, cmd, arity: null, scriptSha: sha };
  }
  return { shape: `${cmd}:${line.args.length}`, cmd, arity: line.args.length, scriptSha: null };
}

export function shapeOfStringArray(command: string[]): string {
  if (command.length === 0) return ':0';
  const cmd = command[0].toUpperCase();
  if (SCRIPTED_VERBS.has(cmd)) {
    return `${cmd}:${command[1] ?? '<unknown>'}`;
  }
  return `${cmd}:${command.length - 1}`;
}

function firstArgOf(command: string[]): string | null {
  return command.length > 1 ? command[1] : null;
}

export function computeNewShapes(
  capturedLines: ParsedMonitorLine[],
  baselineShapes: Set<string>,
): NewShape[] {
  const captureCounts = new Map<string, { count: number; meta: ReturnType<typeof shapeOf> }>();
  for (const line of capturedLines) {
    const meta = shapeOf(line);
    const existing = captureCounts.get(meta.shape);
    if (existing) {
      existing.count += 1;
    } else {
      captureCounts.set(meta.shape, { count: 1, meta });
    }
  }

  const newShapes: NewShape[] = [];
  for (const [shape, { count, meta }] of captureCounts) {
    if (baselineShapes.has(shape)) continue;
    // A shape's verb may also have been seen in client-snapshots as `VERB:*` —
    // that covers all arities, so the shape is not "new".
    if (baselineShapes.has(`${meta.cmd}:*`)) continue;
    newShapes.push({
      shape,
      cmd: meta.cmd,
      arity: meta.arity,
      scriptSha: meta.scriptSha,
      countInCapture: count,
    });
  }
  newShapes.sort((a, b) => b.countInCapture - a.countInCapture);
  return newShapes;
}

export function computeHotKeyDelta(
  capturedLines: ParsedMonitorLine[],
  baselineKeyCounts: Map<string, number>,
): HotKeyDelta {
  const captureCounts = new Map<string, number>();
  for (const line of capturedLines) {
    if (!line.key) continue;
    captureCounts.set(line.key, (captureCounts.get(line.key) ?? 0) + 1);
  }

  const captureRanked = Array.from(captureCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOT_KEY_TOP_K);
  const baselineRanked = Array.from(baselineKeyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOT_KEY_TOP_K);

  const baselineRankByKey = new Map<string, number>();
  baselineRanked.forEach(([key], i) => baselineRankByKey.set(key, i + 1));

  const newInTopK: HotKey[] = [];
  const rankChanges: HotKey[] = [];
  captureRanked.forEach(([key, count], i) => {
    const captureRank = i + 1;
    const baselineRank = baselineRankByKey.get(key) ?? null;
    const baselineCount = baselineKeyCounts.get(key) ?? 0;
    const row: HotKey = {
      key,
      countInCapture: count,
      countInBaseline: baselineCount,
      rankInCapture: captureRank,
      rankInBaseline: baselineRank,
    };
    if (baselineRank === null) {
      newInTopK.push(row);
    } else if (captureRank !== baselineRank) {
      rankChanges.push(row);
    }
  });
  return { newInTopK, rankChanges };
}

export function computeSlowlogRegressions(
  capturedLines: ParsedMonitorLine[],
  slowlogBaseline: StoredSlowLogEntry[],
  slowlogSession: StoredSlowLogEntry[],
  baselineStartMs: number,
  baselineEndMs: number,
  sessionStartMs: number,
  sessionEndMs: number,
): SlowlogRegression[] {
  const captureVerbs = new Set<string>();
  for (const line of capturedLines) captureVerbs.add(line.cmd.toUpperCase());

  const baselineDurationSec = Math.max(1, (baselineEndMs - baselineStartMs) / 1000);
  const sessionDurationSec = Math.max(1, (sessionEndMs - sessionStartMs) / 1000);

  const baselineCountsByVerb = countByVerb(slowlogBaseline);
  const sessionCountsByVerb = countByVerb(slowlogSession);

  // Per-verb baseline rates, used for the p95 cutoff.
  const baselineRates: number[] = [];
  for (const count of baselineCountsByVerb.values()) {
    baselineRates.push(count / baselineDurationSec);
  }
  const p95 = percentile(baselineRates, 0.95);

  const regressions: SlowlogRegression[] = [];
  for (const verb of captureVerbs) {
    const sessionCount = sessionCountsByVerb.get(verb) ?? 0;
    if (sessionCount === 0) continue;
    const observedRate = sessionCount / sessionDurationSec;
    const baselineCount = baselineCountsByVerb.get(verb) ?? 0;
    const baselineRate = baselineCount / baselineDurationSec;
    if (observedRate <= p95) continue;
    regressions.push({
      cmd: verb,
      shape: `${verb}:slowlog`,
      slowlogCountInSession: sessionCount,
      observedRatePerSec: observedRate,
      baselineRatePerSec: baselineRate,
      baselineP95RatePerSec: p95,
    });
  }
  regressions.sort((a, b) => b.observedRatePerSec - a.observedRatePerSec);
  return regressions;
}

function countByVerb(entries: StoredSlowLogEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.command.length === 0) continue;
    const verb = e.command[0].toUpperCase();
    out.set(verb, (out.get(verb) ?? 0) + 1);
  }
  return out;
}

/** Linear-interpolated percentile (q in [0,1]). Returns 0 for empty input. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
