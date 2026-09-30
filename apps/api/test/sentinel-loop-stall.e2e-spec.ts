import Valkey from 'iovalkey';
import { execSync } from 'child_process';
import { join } from 'path';
import { InfoParser } from '../src/database/parsers/info.parser';
import { MetricsParser } from '../src/database/parsers/metrics.parser';
import { isSentinelMode } from '../../../proprietary/anomaly-detection/sentinel-drift-detector';
import {
  DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS,
  createSentinelLoopStallState,
  evaluateSentinelLoopStall,
} from '../../../proprietary/anomaly-detection/sentinel-loop-stall-detector';

/**
 * Sentinel loop-stall / TILT E2E (valkey-sentinel-tilt-repro).
 *
 * Two concerns, one suite:
 *
 * 1. Field plumbing (always, against the in-repo docker-compose.sentinel-e2e.yml):
 *    a hand-built fixture cannot prove that `INFO` really carries `sentinel_tilt` /
 *    `sentinel_tilt_since_seconds` under the modelled names and that they survive
 *    InfoParser -> the flattened record the service reads. On a healthy baseline the
 *    detector must ALSO stay silent. This is the analogue of sentinel-topology.e2e's
 *    field-name guard for the drift detector.
 *
 * 2. Fault scenarios (only when SENTINEL_TILT_HARNESS_DIR points at a checkout of
 *    https://github.com/BetterDB-inc/valkey-sentinel-tilt-repro): scenarios A and
 *    Amild2 drive the loop into TILT / RTT stall; the `split` scenario produces a
 *    real +sdown with a healthy loop (misdirected resolution, no TILT). We assert
 *    the detector fires the stall on the former and classifies the latter as
 *    misdirected DNS with no TILT.
 *
 * Requires Docker. Skipped unless RUN_SENTINEL_TESTS=true.
 */

const RUN = process.env.RUN_SENTINEL_TESTS === 'true';
const HARNESS_DIR = process.env.SENTINEL_TILT_HARNESS_DIR;

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(PROJECT_ROOT, 'docker-compose.sentinel-e2e.yml');
const COMPOSE_PROJECT = 'sentinel-loop-stall-e2e';
const SENTINEL_PORT = 26420;
const MASTER_NAME = 'mymaster';

function compose(cmd: string): string {
  return execSync(`docker compose -p ${COMPOSE_PROJECT} -f "${COMPOSE_FILE}" ${cmd}`, {
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

/** INFO -> the flat string record the anomaly service reads (convertInfoToRecord shape). */
function infoToRecord(raw: string): Record<string, string> {
  const parsed = MetricsParser.parseInfoToTyped(InfoParser.parse(raw));
  const record: Record<string, string> = {};
  for (const section of Object.values(parsed)) {
    if (section !== null && typeof section === 'object') {
      for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
        record[key] = String(value);
      }
    }
  }
  return record;
}

async function readInfoRecord(client: Valkey): Promise<{ record: Record<string, string>; rttMs: number }> {
  const start = Date.now();
  const raw = (await client.call('INFO')) as string;
  const rttMs = Date.now() - start;
  return { record: infoToRecord(raw), rttMs };
}

async function waitForSentinelReady(client: Valkey): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const { record } = await readInfoRecord(client);
      if (isSentinelMode(record) && record['sentinel_masters'] !== undefined) {
        return;
      }
    } catch {
      // Sentinel not up yet.
    }
    await sleep(1_000);
  }
  throw new Error('Sentinel did not become ready in time');
}

(RUN ? describe : describe.skip)('Sentinel loop-stall E2E — baseline plumbing', () => {
  let client: Valkey;

  beforeAll(async () => {
    try {
      compose('down --remove-orphans --volumes');
    } catch {
      // Nothing running yet.
    }
    compose('up -d');
    client = new Valkey({ host: '127.0.0.1', port: SENTINEL_PORT, lazyConnect: true });
    await client.connect();
    await waitForSentinelReady(client);
  }, 240_000);

  afterAll(async () => {
    try {
      await client?.quit();
    } catch {
      // Already closed.
    }
    try {
      compose('down --remove-orphans --volumes');
    } catch {
      // Best effort.
    }
  }, 120_000);

  it('carries sentinel_tilt / sentinel_tilt_since_seconds through INFO under the modelled names', async () => {
    const { record } = await readInfoRecord(client);
    // A field-name mismatch shows up here: the keys must survive into the flat record.
    expect(record['sentinel_tilt']).toBeDefined();
    // tilt_since_seconds is newer; assert it when present (8.x/9.x), but do not fail
    // an older baseline that only emits the flag.
    if (record['sentinel_tilt_since_seconds'] !== undefined) {
      expect(Number(record['sentinel_tilt_since_seconds'])).toBe(-1);
    }
    expect(record['sentinel_tilt']).toBe('0');
  });

  it('stays silent on a healthy baseline (no TILT, flat RTT)', async () => {
    const state = createSentinelLoopStallState();
    // A window of real polls against the healthy Sentinel.
    for (let i = 0; i < DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS.rttWindow + 2; i += 1) {
      const { record, rttMs } = await readInfoRecord(client);
      const tiltSince = record['sentinel_tilt_since_seconds'];
      const tiltFlag = record['sentinel_tilt'];
      const findings = evaluateSentinelLoopStall(state, {
        timestamp: Date.now(),
        tiltSinceSeconds: tiltSince !== undefined ? Number(tiltSince) : null,
        tiltFlag: tiltFlag !== undefined ? tiltFlag === '1' : null,
        probeRttMs: rttMs,
        commandTimedOut: false,
        masterDown: false,
        thresholds: DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS,
      });
      expect(findings).toEqual([]);
      await sleep(200);
    }
  });
});

/**
 * Fault scenarios from the published harness. The harness owns the slow-DNS /
 * split-horizon injection; we only drive its compose and read the resulting INFO +
 * SENTINEL view through the same detector the service uses.
 *
 * Enable by cloning the harness and pointing SENTINEL_TILT_HARNESS_DIR at it:
 *   git clone https://github.com/BetterDB-inc/valkey-sentinel-tilt-repro
 *   RUN_SENTINEL_TESTS=true SENTINEL_TILT_HARNESS_DIR=./valkey-sentinel-tilt-repro pnpm test:sentinel-loop-stall
 */
const RUN_SCENARIOS = RUN && typeof HARNESS_DIR === 'string' && HARNESS_DIR.length > 0;

(RUN_SCENARIOS ? describe : describe.skip)('Sentinel loop-stall E2E — harness scenarios', () => {
  const harnessCompose = (scenario: string, cmd: string): string => {
    return execSync(
      `docker compose -p tilt-${scenario} -f "${join(HARNESS_DIR as string, 'docker-compose.yml')}" ${cmd}`,
      { encoding: 'utf-8', timeout: 180_000, cwd: HARNESS_DIR, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  };

  /** Bring a scenario up, poll the sentinel until it stabilises, return the detector verdict. */
  async function runScenario(
    scenario: string,
    port: number,
  ): Promise<{ kinds: string[]; classifications: string[]; sawTilt: boolean }> {
    harnessCompose(scenario, `--profile ${scenario} up -d`);
    const client = new Valkey({ host: '127.0.0.1', port, lazyConnect: true });
    try {
      await client.connect();
      await waitForSentinelReady(client);
      const state = createSentinelLoopStallState();
      const kinds = new Set<string>();
      const classifications = new Set<string>();
      let sawTilt = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        let record: Record<string, string> = {};
        let rttMs: number | null = null;
        let commandTimedOut = false;
        try {
          const read = await readInfoRecord(client);
          record = read.record;
          rttMs = read.rttMs;
        } catch {
          commandTimedOut = true;
        }
        // null = no fresh view this poll (probe failed): must not read as a recovery,
        // which would reset the misdirected streak. A boolean only after a good probe.
        let masterDownObserved: boolean | null = null;
        try {
          const raw = (await client.call('SENTINEL', 'MASTERS')) as unknown[];
          masterDownObserved = MetricsParser.parseSentinelNodes(raw).some((m) => {
            return m.flags.includes('s_down') || m.flags.includes('o_down');
          });
        } catch {
          // ignore
        }
        const tiltSince = record['sentinel_tilt_since_seconds'];
        const tiltFlag = record['sentinel_tilt'];
        if (tiltFlag === '1' || (tiltSince !== undefined && Number(tiltSince) >= 0)) {
          sawTilt = true;
        }
        const findings = evaluateSentinelLoopStall(state, {
          timestamp: Date.now(),
          tiltSinceSeconds: tiltSince !== undefined ? Number(tiltSince) : null,
          tiltFlag: tiltFlag !== undefined ? tiltFlag === '1' : null,
          probeRttMs: rttMs,
          commandTimedOut,
          // Fresh boolean per poll when SENTINEL MASTERS answers; null when that probe
          // failed (unlike the service, which feeds a 15s snapshot and gates freshness).
          masterDownObserved,
          thresholds: DEFAULT_SENTINEL_LOOP_STALL_THRESHOLDS,
        });
        for (const f of findings) {
          kinds.add(f.kind);
          classifications.add(f.classification);
        }
        await sleep(500);
      }
      return {
        kinds: [...kinds],
        classifications: [...classifications],
        sawTilt,
      };
    } finally {
      try {
        await client.quit();
      } catch {
        // ignore
      }
      try {
        harnessCompose(scenario, 'down --remove-orphans --volumes');
      } catch {
        // ignore
      }
    }
  }

  // Ports are the harness's; override via SENTINEL_TILT_A_PORT etc if it differs.
  const portFor = (name: string, fallback: number): number => {
    const raw = process.env[`SENTINEL_TILT_${name}_PORT`];
    return raw !== undefined ? Number(raw) : fallback;
  };

  it('scenario A: drives the loop into TILT / stall (loop starvation)', async () => {
    const verdict = await runScenario('A', portFor('A', 36379));
    expect(verdict.sawTilt).toBe(true);
    expect(verdict.kinds.some((k) => k === 'tilt' || k === 'rtt_stall' || k === 'timeout_wedge')).toBe(true);
    expect(verdict.classifications).toContain('loop_starvation_dns');
  }, 240_000);

  it('scenario Amild2: RTT stall approaching the trigger', async () => {
    const verdict = await runScenario('Amild2', portFor('AMILD2', 36380));
    expect(verdict.kinds.some((k) => k === 'rtt_stall' || k === 'tilt')).toBe(true);
    expect(verdict.classifications).toContain('loop_starvation_dns');
  }, 240_000);

  it('scenario split: misdirected DNS, +sdown with NO TILT', async () => {
    const verdict = await runScenario('split', portFor('SPLIT', 36381));
    expect(verdict.sawTilt).toBe(false);
    expect(verdict.classifications).toContain('misdirected_resolution');
    expect(verdict.kinds).toContain('misdirected_resolution');
  }, 240_000);
});
