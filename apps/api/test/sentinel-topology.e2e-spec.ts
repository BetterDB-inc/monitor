import Valkey from 'iovalkey';
import { execSync } from 'child_process';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { MetricsParser } from '../src/database/parsers/metrics.parser';
import {
  detectSentinelDrift,
  isSentinelMode,
} from '../../../proprietary/anomaly-detection/sentinel-drift-detector';
import { ConfigModule } from '../src/config/config.module';
import { ConnectionsModule } from '../src/connections/connections.module';
import { TopologyModule } from '../src/topology/topology.module';
import { ConnectionRegistry } from '../src/connections/connection-registry.service';
import { TopologyAutoRegistrationService } from '../src/topology/topology-auto-registration.service';

/**
 * Sentinel topology E2E (valkey-io/valkey#2158).
 *
 * Every other Sentinel test hand-builds `SentinelNodeInfo` or mocks the adapter
 * methods, so `MetricsParser.parseSentinelNodes` never sees a reply from a real
 * server. That leaves one failure mode untested and silent: if upstream names a
 * field differently from the modelled names, the parser returns `[]`, the detector
 * sees an empty topology, and nothing errors — the feature just does nothing while
 * every unit test stays green.
 *
 * This suite closes exactly that gap by asserting the modelled field names against
 * a live Sentinel. Requires Docker. Skipped unless RUN_SENTINEL_TESTS=true.
 * Run via:  pnpm test:sentinel-topology
 */

const RUN = process.env.RUN_SENTINEL_TESTS === 'true';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(PROJECT_ROOT, 'docker-compose.sentinel-e2e.yml');
const COMPOSE_PROJECT = 'sentinel-e2e';

const SENTINEL_PORT = 26420;
const MASTER_NAME = 'mymaster';

function compose(cmd: string): string {
  return execSync(`docker compose -p ${COMPOSE_PROJECT} -f "${COMPOSE_FILE}" ${cmd}`, {
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** A non-IP-literal address, i.e. one Sentinel recorded as an announced name. */
function isHostnameish(address: string): boolean {
  return /^[0-9.]+$/.test(address) === false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

/**
 * Wait until Sentinel has discovered the replica AND refreshed its INFO.
 *
 * `replicas.length > 0` is not enough: for the first moments after discovery
 * Sentinel reports the entry with no usable `master-port`, so a test that only
 * waits for the entry races the fields it wants to assert on.
 */
async function waitForSentinel(client: Valkey): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const raw = (await client.call('SENTINEL', 'REPLICAS', MASTER_NAME)) as unknown[];
      const replicas = MetricsParser.parseSentinelNodes(raw);
      const ready = replicas.some((replica) => {
        return replica.masterHost !== undefined && (replica.masterPort ?? 0) > 0;
      });
      if (ready) {
        return;
      }
    } catch {
      // Sentinel not up yet.
    }
    await sleep(1_000);
  }
  throw new Error('Sentinel did not report a usable replica master pointer in time');
}

/** Polls `predicate` every 500ms until it resolves true or `timeoutMs` elapses. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(500);
  }
  throw new Error('Condition was not met in time');
}

(RUN ? describe : describe.skip)('Sentinel topology E2E', () => {
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
    await waitForSentinel(client);
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

  it('reports itself as a Sentinel through the mode gate', async () => {
    const raw = (await client.call('INFO', 'server')) as string;
    const info: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const [key, value] = line.split(':');
      if (key !== undefined && value !== undefined) {
        info[key.trim()] = value.trim();
      }
    }

    // Guards against the gate this stack already got wrong once: Valkey emits
    // server_mode, not redis_mode, unless extended-redis-compat is on.
    expect(isSentinelMode(info)).toBe(true);
  });

  it('parses a live SENTINEL MASTERS reply with every modelled field populated', async () => {
    const raw = (await client.call('SENTINEL', 'MASTERS')) as unknown[];
    const masters = MetricsParser.parseSentinelNodes(raw);

    // A field-name mismatch shows up here as an empty array.
    expect(masters).toHaveLength(1);
    const [master] = masters;
    expect(master.name).toBe(MASTER_NAME);
    expect(master.ip).not.toBe('');
    expect(master.port).toBeGreaterThan(0);
    expect(master.runid).not.toBe('');
    expect(master.flags).toContain('master');
  });

  it('parses a live SENTINEL REPLICAS reply including the master pointer', async () => {
    const raw = (await client.call('SENTINEL', 'REPLICAS', MASTER_NAME)) as unknown[];
    const replicas = MetricsParser.parseSentinelNodes(raw);

    expect(replicas.length).toBeGreaterThan(0);
    const [replica] = replicas;
    expect(replica.ip).not.toBe('');
    expect(replica.port).toBeGreaterThan(0);
    expect(replica.flags).toContain('slave');
    // master-host / master-port are what the stale-pointer check reads, and they
    // only appear on the REPLICAS reply.
    expect(replica.masterHost).toBeDefined();
    expect(replica.masterPort).toBeGreaterThan(0);
  });

  it('detects the real valkey#2158 mixture end to end', async () => {
    const masters = MetricsParser.parseSentinelNodes(
      (await client.call('SENTINEL', 'MASTERS')) as unknown[],
    );
    const replicas = MetricsParser.parseSentinelNodes(
      (await client.call('SENTINEL', 'REPLICAS', MASTER_NAME)) as unknown[],
    );

    // This is the bug reproduced, not simulated. With announce-hostnames on,
    // Sentinel records the MASTER under its announced hostname but the replica
    // under the address it resolved — a raw container IP. That mixture is exactly
    // what valkey#2158 describes, and it arises here from Sentinel's own behaviour
    // rather than from a fixture we wrote.
    expect(isHostnameish(masters[0].ip)).toBe(true);
    expect(replicas[0].ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    const findings = detectSentinelDrift(masters[0], replicas);

    const ipForHostname = findings.filter((finding) => {
      return finding.reason === 'ip_for_hostname';
    });
    expect(ipForHostname).toHaveLength(1);
    expect(ipForHostname[0].endpoint).toContain(replicas[0].ip);

    // The master pointer is a hostname here, so the stale-pointer check must stay
    // quiet — it is a separate signal and must not piggyback on the ip mixture.
    expect(
      findings.some((finding) => {
        return finding.reason === 'stale_master_pointer';
      }),
    ).toBe(false);
  });

  describe('node auto-registration and failover following', () => {
    let appContext: INestApplicationContext;
    let registry: ConnectionRegistry;
    let service: TopologyAutoRegistrationService;
    let seedId: string;

    beforeAll(async () => {
      process.env.BETTERDB_TELEMETRY = 'false';
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule, ConnectionsModule, TopologyModule],
      }).compile();
      appContext = await moduleRef.init();

      registry = appContext.get(ConnectionRegistry);
      service = appContext.get(TopologyAutoRegistrationService);
      seedId = await registry.addConnection({ name: 'sentinel', host: '127.0.0.1', port: SENTINEL_PORT });
      await registry.setAutoRegister(seedId, true);
    }, 60_000);

    afterAll(async () => {
      await appContext?.close();
      delete process.env.BETTERDB_TELEMETRY;
    });

    // The compose stack runs with `announce-hostnames yes` (see docker-compose.sentinel-e2e.yml),
    // so Sentinel reports the master under a Docker-internal hostname and the replica under a
    // raw container IP — neither reachable from the host running this test. addManagedChild()
    // still registers a child for each regardless of whether it can connect, so the assertions
    // here stay scoped to what reconcile() derives from Sentinel's own replies (ids and roles),
    // not to whether the registered children can actually be reached.
    it('registers the monitored nodes and follows a failover', async () => {
      await service.reconcile(seedId);
      const before = registry.listMembers(seedId);
      expect(before.map((m) => m.membership?.role).sort()).toEqual(['primary', 'replica']);

      const beforePrimary = before.find((m) => m.membership?.role === 'primary');
      expect(beforePrimary).toBeDefined();

      await client.call('SENTINEL', 'FAILOVER', MASTER_NAME);
      await waitFor(async () => {
        await service.reconcile(seedId);
        const primary = registry.listMembers(seedId).find((m) => m.membership?.role === 'primary');
        return primary !== undefined && primary.id !== beforePrimary!.id;
      }, 30_000);

      const after = registry.listMembers(seedId);
      expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
      expect(after.map((m) => m.membership?.role).sort()).toEqual(['primary', 'replica']);
    }, 60_000);
  });
});
