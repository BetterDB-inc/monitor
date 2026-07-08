/**
 * Pure detection logic for the P99 latency regression guard (valkey/valkey#3527).
 *
 * One RegressionDetector instance tracks one connection. It receives storage-derived
 * samples via evaluate() and returns findings — no NestJS, storage, or network
 * dependencies, so the full rule set is unit-testable.
 *
 * Rules:
 * 1. Upgrade regression: a server version change opens a 24h window. Baseline is the
 *    per-command median p99 over the last 6h of old-version samples. Fires ONE
 *    aggregated finding when >=1 eligible command stays >=1.5x baseline (and >=1ms
 *    above it) for 5 consecutive samples.
 * 2. Sustained degradation (no upgrade): rolling median baseline over [now-24h, now-5m];
 *    fires per command at >=2x baseline (and >=1ms above it) for 5 consecutive samples,
 *    with a 30min per-command cooldown. Skipped while an unfired upgrade window is open.
 *
 * Topology-refresh correlation (the hourly-spike symptom in #3527) is an annotation on
 * either rule, derived from cluster|slots / cluster|shards call-volume bursts.
 */

import {
  ClusterRefreshPoint,
  CommandP99Point,
  CommandRegression,
  DetectorInput,
  RegressionFinding,
} from './types';

// --- Tunables (exported for tests) ---
export const UPGRADE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UPGRADE_BASELINE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
export const UPGRADE_MIN_BASELINE_SAMPLES = 5;
export const UPGRADE_DEGRADATION_FACTOR = 1.5;
export const SUSTAINED_DEGRADATION_FACTOR = 2.0;
export const SUSTAINED_MIN_BASELINE_SAMPLES = 30;
export const SUSTAINED_BASELINE_EXCLUDE_MS = 5 * 60 * 1000;
export const SUSTAINED_COOLDOWN_MS = 30 * 60 * 1000;
/** Minimum absolute degradation (current - baseline) to count, in microseconds. */
export const MIN_ABS_DEGRADATION_US = 1000;
export const CONSECUTIVE_REQUIRED = 5;
export const MIN_CALLS_PER_MIN = 60;
export const TOP_K_COMMANDS = 20;
/** Latest sample older than this is considered stale (2 poll intervals + margin). */
export const STALE_SAMPLE_MS = 150_000;
export const CRITICAL_UPGRADE_FACTOR = 3;
export const CRITICAL_P99_US = 100_000;
export const CRITICAL_SUSTAINED_FACTOR = 4;
/** Window around a firing in which a topology-refresh burst counts as correlated. */
export const TOPOLOGY_CORRELATION_WINDOW_MS = CONSECUTIVE_REQUIRED * 60_000;
export const TOPOLOGY_BURST_MIN_CALLS = 10;
export const TOPOLOGY_BURST_MEDIAN_FACTOR = 2;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function parseMajorVersion(version: string): number {
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) ? major : 0;
}

function isDegraded(currentP99Us: number, baselineP99Us: number, factor: number): boolean {
  return (
    baselineP99Us > 0 &&
    currentP99Us >= factor * baselineP99Us &&
    currentP99Us - baselineP99Us >= MIN_ABS_DEGRADATION_US
  );
}

/**
 * True when cluster|slots / cluster|shards call volume bursts inside
 * [windowStartMs, windowEndMs] above max(10, 2x the median of all provided points).
 * Callers provide roughly the last hour of deltas.
 */
export function isTopologyRefreshCorrelated(
  deltas: ClusterRefreshPoint[],
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  if (deltas.length === 0) return false;
  const hourMedian = median(deltas.map((d) => d.callsDelta));
  const threshold = Math.max(
    TOPOLOGY_BURST_MIN_CALLS,
    TOPOLOGY_BURST_MEDIAN_FACTOR * hourMedian,
  );
  return deltas.some(
    (d) => d.capturedAt >= windowStartMs && d.capturedAt <= windowEndMs && d.callsDelta > threshold,
  );
}

function formatMs(us: number): string {
  return `${(us / 1000).toFixed(1)}ms`;
}

function describeCommands(commands: CommandRegression[]): string {
  return commands
    .map(
      (c) =>
        `${c.command} p99 ${formatMs(c.currentP99Us)} (baseline ${formatMs(c.baselineP99Us)}, ${c.degradationFactor.toFixed(1)}x)`,
    )
    .join('; ');
}

const TOPOLOGY_NOTE =
  ' Spikes correlate with cluster topology refresh (cluster|slots/cluster|shards bursts) — check the client topology refresh interval.';

interface UpgradeWindowState {
  fromVersion: string;
  toVersion: string;
  openedAtMs: number;
  /** Per-command median p99 (us) from old-version samples; commands without enough samples absent. */
  baselines: Map<string, number>;
  consecutive: Map<string, number>;
  /** capturedAt of the last sample counted toward `consecutive`, per command. */
  lastCountedAt: Map<string, number>;
  fired: boolean;
}

interface SustainedState {
  consecutive: number;
  lastFiredAt: number;
  /** capturedAt of the last sample counted toward `consecutive`. */
  lastCountedAt: number;
}

export class RegressionDetector {
  private lastVersion?: string;
  private upgrade?: UpgradeWindowState;
  private sustained = new Map<string, SustainedState>();

  evaluate(input: DetectorInput): RegressionFinding[] {
    const { nowMs, samples } = input;
    if (samples.length === 0) return [];

    const latestByCommand = this.latestByCommand(samples);
    const currentVersion = this.currentVersion(samples);

    this.trackVersion(currentVersion, nowMs, samples);

    if (this.upgrade && nowMs - this.upgrade.openedAtMs > UPGRADE_WINDOW_MS) {
      this.upgrade = undefined;
    }

    const eligible = this.eligibleCommands(input.callsPerMin);
    const findings: RegressionFinding[] = [];

    const upgradeFinding = this.evaluateUpgrade(input, latestByCommand, eligible);
    if (upgradeFinding) findings.push(upgradeFinding);

    // Sustained is suppressed only for the commands an open upgrade window actually owns
    // (those with an upgrade baseline). The upgrade rule fires once per such command, so
    // suppressing them for the whole window — fired or not — avoids re-reporting the same
    // post-upgrade regression via sustained. Commands without an upgrade baseline (e.g. a
    // version change where nothing had enough pre-change samples) are NOT suppressed, so an
    // empty upgrade window can't silence sustained detection for up to 24h.
    findings.push(...this.evaluateSustained(input, latestByCommand, eligible, currentVersion));

    return findings;
  }

  /** Latest sample per command (samples are ascending by capturedAt, but don't rely on it). */
  private latestByCommand(samples: CommandP99Point[]): Map<string, CommandP99Point> {
    const latest = new Map<string, CommandP99Point>();
    for (const s of samples) {
      const prev = latest.get(s.command);
      if (!prev || s.capturedAt >= prev.capturedAt) latest.set(s.command, s);
    }
    return latest;
  }

  private currentVersion(samples: CommandP99Point[]): string {
    let newest = samples[0];
    for (const s of samples) {
      if (s.capturedAt >= newest.capturedAt) newest = s;
    }
    return newest.serverVersion;
  }

  private trackVersion(currentVersion: string, nowMs: number, samples: CommandP99Point[]): void {
    if (!currentVersion) return;
    if (this.lastVersion === undefined) {
      this.lastVersion = currentVersion;
      return;
    }
    if (currentVersion === this.lastVersion) return;

    // Always track the latest reported version...
    const fromVersion = this.lastVersion;
    this.lastVersion = currentVersion;

    // ...but only a major-version *increase* (e.g. 8.x -> 9.0) is an upgrade worth a regression
    // window. A patch/minor/build-metadata flip (7.4.0 -> 7.4.1) or a downgrade must not open a
    // window: doing so would clear every command's sustained cooldown/streak below (re-firing a
    // sustained finding inside its 30-min cooldown) and mislabel the change as upgrade_regression.
    if (parseMajorVersion(currentVersion) <= parseMajorVersion(fromVersion)) {
      // If an upgrade window is open and we have rolled back BELOW its target major, the upgrade
      // being monitored has been reverted. Close the window so it stops suppressing sustained
      // detection on the reverted version (evaluateSustained mutes commands the window owns) and
      // we don't hold an unfireable window open for the rest of the 24h.
      if (this.upgrade && parseMajorVersion(currentVersion) < parseMajorVersion(this.upgrade.toVersion)) {
        this.upgrade = undefined;
      }
      return;
    }

    // Major upgrade: open (or replace) the upgrade window.
    const baselines = new Map<string, number>();
    const byCommand = new Map<string, number[]>();
    for (const s of samples) {
      if (s.serverVersion !== fromVersion) continue;
      if (s.capturedAt < nowMs - UPGRADE_BASELINE_LOOKBACK_MS) continue;
      const arr = byCommand.get(s.command) ?? [];
      arr.push(s.p99Us);
      byCommand.set(s.command, arr);
    }
    for (const [command, values] of byCommand) {
      if (values.length >= UPGRADE_MIN_BASELINE_SAMPLES) {
        baselines.set(command, median(values));
      }
    }

    this.upgrade = {
      fromVersion,
      toVersion: currentVersion,
      openedAtMs: nowMs,
      baselines,
      consecutive: new Map(),
      lastCountedAt: new Map(),
      fired: false,
    };
    this.sustained.clear();
  }

  /** Commands with enough volume, capped to the top-K by volume. */
  private eligibleCommands(callsPerMin: Map<string, number>): Set<string> {
    const ranked = [...callsPerMin.entries()]
      .filter(([, cpm]) => cpm >= MIN_CALLS_PER_MIN)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_K_COMMANDS);
    return new Set(ranked.map(([command]) => command));
  }

  private evaluateUpgrade(
    input: DetectorInput,
    latestByCommand: Map<string, CommandP99Point>,
    eligible: Set<string>,
  ): RegressionFinding | null {
    const upgrade = this.upgrade;
    if (!upgrade || upgrade.fired) return null;

    const { nowMs } = input;
    for (const [command, baseline] of upgrade.baselines) {
      if (!eligible.has(command)) {
        upgrade.consecutive.set(command, 0);
        continue;
      }
      const latest = latestByCommand.get(command);
      // Count the sample if it is still on the upgraded major line (or newer), not only the
      // exact `toVersion` string. A patch/minor bump during the window (9.0.0 -> 9.0.1) must
      // not reset the streak, or a genuine post-major regression could never reach
      // CONSECUTIVE_REQUIRED. A rollback below the target major (9 -> 8) fails this check and
      // resets the streak, which is correct — that is no longer a post-upgrade sample.
      const fresh =
        latest !== undefined &&
        latest.capturedAt >= nowMs - STALE_SAMPLE_MS &&
        parseMajorVersion(latest.serverVersion) >= parseMajorVersion(upgrade.toVersion);
      if (!fresh) {
        upgrade.consecutive.set(command, 0);
        continue;
      }
      // Count physical samples, not poll ticks: only advance the streak when a strictly newer
      // sample arrives. Re-reading the same sample (a skipped poll or a failed storage write
      // keeps getLatencyStatsHistory returning the prior row) must not inflate the count and
      // fire before CONSECUTIVE_REQUIRED genuinely-distinct samples.
      if (latest.capturedAt <= (upgrade.lastCountedAt.get(command) ?? -1)) continue;
      upgrade.lastCountedAt.set(command, latest.capturedAt);
      const degraded = isDegraded(latest.p99Us, baseline, UPGRADE_DEGRADATION_FACTOR);
      upgrade.consecutive.set(command, degraded ? (upgrade.consecutive.get(command) ?? 0) + 1 : 0);
    }

    const regressed: CommandRegression[] = [];
    for (const [command, count] of upgrade.consecutive) {
      if (count < CONSECUTIVE_REQUIRED) continue;
      const latest = latestByCommand.get(command)!;
      const baseline = upgrade.baselines.get(command)!;
      regressed.push({
        command,
        baselineP99Us: baseline,
        currentP99Us: latest.p99Us,
        degradationFactor: latest.p99Us / baseline,
        callsPerMin: input.callsPerMin.get(command) ?? 0,
      });
    }
    if (regressed.length === 0) return null;

    upgrade.fired = true;
    regressed.sort((a, b) => b.degradationFactor - a.degradationFactor);

    const critical = regressed.some(
      (c) => c.degradationFactor >= CRITICAL_UPGRADE_FACTOR || c.currentP99Us >= CRITICAL_P99_US,
    );
    const correlated = isTopologyRefreshCorrelated(
      input.clusterRefreshDeltas,
      nowMs - TOPOLOGY_CORRELATION_WINDOW_MS,
      nowMs,
    );

    let message =
      `P99 latency regression after upgrade ${upgrade.fromVersion} -> ${upgrade.toVersion}: ` +
      describeCommands(regressed) +
      '.';
    if (correlated) message += TOPOLOGY_NOTE;

    return {
      kind: 'upgrade_regression',
      previousVersion: upgrade.fromVersion,
      currentVersion: upgrade.toVersion,
      severity: critical ? 'critical' : 'warning',
      commands: regressed,
      topologyRefreshCorrelated: correlated,
      message,
      timestamp: nowMs,
    };
  }

  private evaluateSustained(
    input: DetectorInput,
    latestByCommand: Map<string, CommandP99Point>,
    eligible: Set<string>,
    currentVersion: string,
  ): RegressionFinding[] {
    const { nowMs, samples } = input;
    const findings: RegressionFinding[] = [];

    // Rolling baselines: any version, [now-24h, now-5m].
    const baselineCutoff = nowMs - SUSTAINED_BASELINE_EXCLUDE_MS;
    const byCommand = new Map<string, number[]>();
    for (const s of samples) {
      if (s.capturedAt > baselineCutoff) continue;
      if (!eligible.has(s.command)) continue;
      const arr = byCommand.get(s.command) ?? [];
      arr.push(s.p99Us);
      byCommand.set(s.command, arr);
    }

    for (const command of eligible) {
      const state = this.sustained.get(command) ?? { consecutive: 0, lastFiredAt: 0, lastCountedAt: -1 };
      this.sustained.set(command, state);

      // Owned by an open upgrade window (the upgrade rule fires once for it) — suppress
      // sustained for this command for the window's lifetime. Commands the window has no
      // baseline for fall through and are evaluated normally.
      if (this.upgrade?.baselines.has(command)) {
        state.consecutive = 0;
        continue;
      }

      const baselineValues = byCommand.get(command);
      const latest = latestByCommand.get(command);
      const fresh = latest !== undefined && latest.capturedAt >= nowMs - STALE_SAMPLE_MS;

      if (!fresh || !baselineValues || baselineValues.length < SUSTAINED_MIN_BASELINE_SAMPLES) {
        state.consecutive = 0;
        continue;
      }

      // Count physical samples, not poll ticks (see evaluateUpgrade): a repeated sample must
      // not advance the streak. `latest` is non-null here (fresh implies defined).
      if (latest!.capturedAt <= state.lastCountedAt) continue;
      state.lastCountedAt = latest!.capturedAt;

      const baseline = median(baselineValues);
      if (!isDegraded(latest!.p99Us, baseline, SUSTAINED_DEGRADATION_FACTOR)) {
        state.consecutive = 0;
        continue;
      }

      state.consecutive += 1;
      if (state.consecutive < CONSECUTIVE_REQUIRED) continue;
      if (nowMs - state.lastFiredAt < SUSTAINED_COOLDOWN_MS) continue;

      state.lastFiredAt = nowMs;
      state.consecutive = 0;

      const factor = latest.p99Us / baseline;
      const regression: CommandRegression = {
        command,
        baselineP99Us: baseline,
        currentP99Us: latest.p99Us,
        degradationFactor: factor,
        callsPerMin: input.callsPerMin.get(command) ?? 0,
      };
      const correlated = isTopologyRefreshCorrelated(
        input.clusterRefreshDeltas,
        nowMs - TOPOLOGY_CORRELATION_WINDOW_MS,
        nowMs,
      );

      let message = `Sustained P99 latency degradation: ${describeCommands([regression])}.`;
      if (correlated) message += TOPOLOGY_NOTE;

      findings.push({
        kind: 'sustained_degradation',
        currentVersion,
        severity: factor >= CRITICAL_SUSTAINED_FACTOR ? 'critical' : 'warning',
        commands: [regression],
        topologyRefreshCorrelated: correlated,
        message,
        timestamp: nowMs,
      });
    }

    return findings;
  }
}
