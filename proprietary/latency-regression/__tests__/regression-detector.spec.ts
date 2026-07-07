import {
  RegressionDetector,
  isTopologyRefreshCorrelated,
  median,
  parseMajorVersion,
  CONSECUTIVE_REQUIRED,
  SUSTAINED_COOLDOWN_MS,
  UPGRADE_WINDOW_MS,
} from '../regression-detector';
import { ClusterRefreshPoint, CommandP99Point, RegressionFinding } from '../types';

const START = 1_700_000_000_000;
const MINUTE = 60_000;

/** Drives a detector with one fresh sample per simulated 60s poll. */
class Sim {
  now = START;
  samples: CommandP99Point[] = [];
  detector = new RegressionDetector();
  callsPerMin = new Map<string, number>([['hmget', 120]]);
  clusterRefreshDeltas: ClusterRefreshPoint[] = [];

  addSample(p99Us: number, serverVersion: string, capturedAt = this.now, command = 'hmget') {
    this.samples.push({ command, p99Us, serverVersion, capturedAt });
  }

  evaluate(): RegressionFinding[] {
    return this.detector.evaluate({
      nowMs: this.now,
      samples: this.samples,
      callsPerMin: this.callsPerMin,
      clusterRefreshDeltas: this.clusterRefreshDeltas,
    });
  }

  /** Advance one poll interval, record a fresh sample, evaluate. */
  tick(p99Us: number, serverVersion: string): RegressionFinding[] {
    this.now += MINUTE;
    this.addSample(p99Us, serverVersion);
    return this.evaluate();
  }
}

describe('helpers', () => {
  it('median handles odd, even, and empty inputs', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([1, 100, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('parseMajorVersion extracts the major version', () => {
    expect(parseMajorVersion('9.0.1')).toBe(9);
    expect(parseMajorVersion('8.1.0')).toBe(8);
    expect(parseMajorVersion('')).toBe(0);
    expect(parseMajorVersion('unknown')).toBe(0);
  });

  describe('isTopologyRefreshCorrelated', () => {
    const base: ClusterRefreshPoint[] = Array.from({ length: 10 }, (_, i) => ({
      capturedAt: START + i * MINUTE,
      callsDelta: 2,
    }));

    it('detects a burst above max(10, 2x median) inside the window', () => {
      const deltas = [...base, { capturedAt: START + 11 * MINUTE, callsDelta: 50 }];
      expect(isTopologyRefreshCorrelated(deltas, START + 10 * MINUTE, START + 12 * MINUTE)).toBe(
        true,
      );
    });

    it('ignores bursts outside the window', () => {
      const deltas = [...base, { capturedAt: START, callsDelta: 50 }];
      expect(isTopologyRefreshCorrelated(deltas, START + 10 * MINUTE, START + 12 * MINUTE)).toBe(
        false,
      );
    });

    it('applies the absolute floor of 10 calls', () => {
      // median 2 -> threshold max(10, 4) = 10; a delta of 8 is not a burst
      const deltas = [...base, { capturedAt: START + 11 * MINUTE, callsDelta: 8 }];
      expect(isTopologyRefreshCorrelated(deltas, START + 10 * MINUTE, START + 12 * MINUTE)).toBe(
        false,
      );
    });

    it('returns false with no data', () => {
      expect(isTopologyRefreshCorrelated([], START, START + MINUTE)).toBe(false);
    });
  });
});

describe('RegressionDetector — upgrade regression', () => {
  function seedOldVersion(sim: Sim, samples = 6, p99 = 2000) {
    for (let i = 0; i < samples; i++) {
      expect(sim.tick(p99, '8.1.0')).toEqual([]);
    }
  }

  it('fires ONE aggregated event after 5 consecutive degraded samples post-upgrade', () => {
    const sim = new Sim();
    seedOldVersion(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      expect(findings).toEqual([]);
      findings = sim.tick(6000, '9.0.0'); // 3x baseline, +4ms
    }

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe('upgrade_regression');
    expect(f.previousVersion).toBe('8.1.0');
    expect(f.currentVersion).toBe('9.0.0');
    expect(f.severity).toBe('critical'); // factor 3 >= 3
    expect(f.commands).toEqual([
      expect.objectContaining({
        command: 'hmget',
        baselineP99Us: 2000,
        currentP99Us: 6000,
        degradationFactor: 3,
        callsPerMin: 120,
      }),
    ]);
    expect(f.message).toContain('8.1.0 -> 9.0.0');

    // One-shot: keeps degrading, never re-fires
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]);
    }
  });

  it('uses warning severity below 3x and 100ms', () => {
    const sim = new Sim();
    seedOldVersion(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      findings = sim.tick(3400, '9.0.0'); // 1.7x, +1.4ms
    }
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('does not fire below the 1.5x factor', () => {
    const sim = new Sim();
    seedOldVersion(sim);
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(2800, '9.0.0')).toEqual([]); // 1.4x
    }
  });

  it('does not fire below the 1ms absolute floor', () => {
    const sim = new Sim();
    seedOldVersion(sim, 6, 100); // baseline 100us
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(400, '9.0.0')).toEqual([]); // 4x but only +300us
    }
  });

  it('resets the consecutive counter when a sample recovers', () => {
    const sim = new Sim();
    seedOldVersion(sim);

    for (let i = 0; i < CONSECUTIVE_REQUIRED - 1; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]);
    }
    expect(sim.tick(2100, '9.0.0')).toEqual([]); // recovery resets

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      expect(findings).toEqual([]);
      findings = sim.tick(6000, '9.0.0');
    }
    expect(findings).toHaveLength(1);
  });

  it('requires >=5 old-version baseline samples', () => {
    const sim = new Sim();
    seedOldVersion(sim, 4); // too few
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]);
    }
  });

  it('expires the upgrade window after 24h', () => {
    const sim = new Sim();
    seedOldVersion(sim);

    expect(sim.tick(2000, '9.0.0')).toEqual([]); // opens window, not degraded

    sim.now += UPGRADE_WINDOW_MS + MINUTE;
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]); // window expired, no upgrade fire
    }
  });

  it('skips commands below 60 calls/min', () => {
    const sim = new Sim();
    sim.callsPerMin = new Map([['hmget', 30]]);
    seedOldVersion(sim);
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]);
    }
  });

  it('caps eligibility to the top-20 commands by volume', () => {
    const sim = new Sim();
    sim.callsPerMin = new Map([
      ...Array.from({ length: 20 }, (_, i) => [`cmd${i}`, 10_000] as [string, number]),
      ['hmget', 120], // ranked 21st
    ]);
    seedOldVersion(sim);
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(6000, '9.0.0')).toEqual([]);
    }
  });

  it('annotates topology-refresh correlation on the finding', () => {
    const sim = new Sim();
    seedOldVersion(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      // steady background of 1 call/min with a burst right at firing time
      sim.clusterRefreshDeltas = [
        ...Array.from({ length: 30 }, (_, j) => ({
          capturedAt: sim.now - j * MINUTE,
          callsDelta: 1,
        })),
        { capturedAt: sim.now + MINUTE, callsDelta: 40 },
      ];
      findings = sim.tick(6000, '9.0.0');
    }

    expect(findings).toHaveLength(1);
    expect(findings[0].topologyRefreshCorrelated).toBe(true);
    expect(findings[0].message).toContain('topology refresh');
  });
});

describe('RegressionDetector — sustained degradation', () => {
  /** Seeds >=30 baseline samples at `p99` ending before the now-5m exclusion window. */
  function seedBaseline(sim: Sim, count = 40, p99 = 1000) {
    for (let i = 0; i < count; i++) {
      sim.addSample(p99, '8.1.0', sim.now - (count - i + 10) * MINUTE);
    }
    // establish lastVersion without firing anything
    sim.addSample(p99, '8.1.0', sim.now);
    expect(sim.evaluate()).toEqual([]);
  }

  it('fires per command after 5 consecutive samples at >=2x baseline', () => {
    const sim = new Sim();
    seedBaseline(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      expect(findings).toEqual([]);
      findings = sim.tick(2500, '8.1.0'); // 2.5x, +1.5ms
    }

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe('sustained_degradation');
    expect(f.previousVersion).toBeUndefined();
    expect(f.currentVersion).toBe('8.1.0');
    expect(f.severity).toBe('warning');
    expect(f.commands[0]).toMatchObject({ command: 'hmget', baselineP99Us: 1000 });
  });

  it('does not fire below 2x baseline', () => {
    const sim = new Sim();
    seedBaseline(sim);
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(1800, '8.1.0')).toEqual([]); // 1.8x
    }
  });

  it('requires >=30 baseline samples', () => {
    const sim = new Sim();
    seedBaseline(sim, 20);
    for (let i = 0; i < 10; i++) {
      expect(sim.tick(2500, '8.1.0')).toEqual([]);
    }
  });

  it('is critical at >=4x baseline', () => {
    const sim = new Sim();
    seedBaseline(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      findings = sim.tick(4500, '8.1.0');
    }
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('applies a 30min per-command cooldown', () => {
    const sim = new Sim();
    seedBaseline(sim);

    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      findings = sim.tick(2500, '8.1.0');
    }
    expect(findings).toHaveLength(1);

    // Still degraded — suppressed while in cooldown
    const cooldownTicks = Math.floor(SUSTAINED_COOLDOWN_MS / MINUTE) - 1;
    for (let i = 0; i < cooldownTicks; i++) {
      expect(sim.tick(2500, '8.1.0')).toEqual([]);
    }

    // Cooldown elapsed and still degraded — fires again
    let refired: RegressionFinding[] = [];
    for (let i = 0; i < 5 && refired.length === 0; i++) {
      refired = sim.tick(2500, '8.1.0');
    }
    expect(refired).toHaveLength(1);
  });

  it('is suppressed while an unfired upgrade window is open', () => {
    const sim = new Sim();
    seedBaseline(sim);

    // Version change opens an upgrade window (baselines exist from 8.1.0 samples).
    // 2.5x satisfies the sustained rule but ALSO the upgrade rule (>=1.5x), so
    // pick a level that only the sustained rule would match: none exists since
    // sustained threshold (2x) > upgrade threshold (1.5x). Instead verify the
    // finding that does fire is the upgrade one, not sustained.
    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      expect(findings).toEqual([]);
      findings = sim.tick(2500, '9.0.0');
    }
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('upgrade_regression');
  });

  it('does not re-fire via the sustained rule after the upgrade event has fired', () => {
    const sim = new Sim();
    seedBaseline(sim); // >=30 baseline samples, so the sustained rule is otherwise armed

    // Upgrade to 9.0.0 at 2.5x: fires ONE upgrade event.
    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      findings = sim.tick(2500, '9.0.0');
    }
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('upgrade_regression');

    // The regression persists. Sustained would otherwise satisfy 2x + 5 consecutive within
    // this window; it must stay suppressed for the rest of the (still-open) upgrade window.
    for (let i = 0; i < 20; i++) {
      expect(sim.tick(2500, '9.0.0')).toEqual([]);
    }
  });

  it('still fires sustained when a version change opens an upgrade window with no baselines', () => {
    const sim = new Sim();
    // 40 old-version samples, all OLDER than the 6h upgrade-baseline lookback but within the
    // 24h sustained window: enough for a sustained baseline, too old for an upgrade baseline.
    for (let i = 0; i < 40; i++) {
      sim.addSample(1000, '8.1.0', sim.now - (7 * 60 + i) * MINUTE);
    }
    // Establish lastVersion on the old version without opening a window yet.
    sim.addSample(1000, '8.1.0', sim.now);
    expect(sim.evaluate()).toEqual([]);

    // Version change opens an upgrade window, but no command has >=5 samples within 6h,
    // so baselines are empty. Sustained must NOT be suppressed for these commands.
    let findings: RegressionFinding[] = [];
    for (let i = 0; i < CONSECUTIVE_REQUIRED; i++) {
      expect(findings).toEqual([]);
      findings = sim.tick(2500, '9.0.0'); // 2.5x the sustained baseline
    }
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('sustained_degradation');
  });
});
