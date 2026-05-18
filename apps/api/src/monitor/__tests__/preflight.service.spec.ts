import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { AclChecker } from '../acl-checker';
import type { HealthGateService } from '../health-gate.service';
import type { MonitorSupportProbe, MonitorSupportResult } from '../monitor-support-probe';
import { PreflightService } from '../preflight.service';

const CONNECTION_ID = 'conn-1';

function makeService({
  info,
  host = 'redis.local',
  acl = { username: 'default', hasMonitor: true },
  health = {
    allow: true,
    signals: { memoryPct: 0.1, oomEventsRecent: 0, replicationLagBytes: 0, failoverInProgress: false },
    thresholds: { memoryPctThreshold: 0.85, replicationLagThresholdBytes: 10485760 },
  },
  monitorSupport,
}: {
  info: unknown;
  host?: string;
  acl?: unknown;
  health?: unknown;
  monitorSupport?: MonitorSupportResult;
} = { info: {} }) {
  const client = { getInfoParsed: jest.fn().mockResolvedValue(info) };
  const registry = {
    get: jest.fn().mockReturnValue(client),
    getConfig: jest.fn().mockReturnValue({ host, port: 6379 }),
  } as unknown as ConnectionRegistry;
  const aclChecker = { check: jest.fn().mockResolvedValue(acl) } as unknown as AclChecker;
  const healthGate = { evaluate: jest.fn().mockResolvedValue(health) } as unknown as HealthGateService;
  const monitorSupportProbe = {
    probe: jest.fn(),
    getCached: jest.fn().mockReturnValue(monitorSupport),
  } as unknown as MonitorSupportProbe;
  return {
    service: new PreflightService(registry, aclChecker, healthGate, monitorSupportProbe),
    aclChecker,
    healthGate,
    monitorSupportProbe,
    registry,
  };
}

describe('PreflightService', () => {
  it('returns monitorSupport=null when no probe has run yet (preflight never triggers probing)', async () => {
    const { service, monitorSupportProbe } = makeService({
      info: { stats: { instantaneous_ops_per_sec: '0' } },
      // monitorSupport intentionally undefined -> getCached returns undefined
    });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.monitorSupport).toBeNull();
    expect(monitorSupportProbe.getCached).toHaveBeenCalledWith(CONNECTION_ID);
    expect(monitorSupportProbe.probe).not.toHaveBeenCalled();
  });

  it('surfaces the cached probe result when one exists', async () => {
    const monitorSupport: MonitorSupportResult = {
      status: 'no',
      source: 'live-monitor',
      checkedAt: 1700000000999,
      detail: 'NOPERM MONITOR is not allowed',
    };
    const { service, monitorSupportProbe } = makeService({
      info: { stats: { instantaneous_ops_per_sec: '0' } },
      monitorSupport,
    });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.monitorSupport).toEqual(monitorSupport);
    expect(monitorSupportProbe.probe).not.toHaveBeenCalled();
  });

  it('composes provider, acl, health, and throughput from one INFO call + downstream services', async () => {
    const { service, aclChecker, healthGate } = makeService({
      info: {
        server: { os: 'Linux 6.1 Debian' },
        stats: {
          instantaneous_ops_per_sec: '500',
          instantaneous_input_kbps: '12.5',
          instantaneous_output_kbps: '40.0',
        },
      },
    });

    const result = await service.run({ connectionId: CONNECTION_ID, durationMs: 60_000 });

    expect(result.connectionId).toBe(CONNECTION_ID);
    expect(result.provider.provider).toBe('self-hosted');
    expect(result.acl).toEqual({ username: 'default', hasMonitor: true });
    expect(result.health.allow).toBe(true);
    expect(result.throughput).toEqual({
      opsPerSec: 500,
      inputKbps: 12.5,
      outputKbps: 40,
      durationMs: 60_000,
      estimatedLines: 30_000, // 500 * 60s
      estimatedBytes: 30_000 * 120,
    });
    expect(aclChecker.check).toHaveBeenCalledWith(CONNECTION_ID);
    expect(healthGate.evaluate).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it('detects provider from the connection host suffix', async () => {
    const { service } = makeService({
      info: {
        server: {},
        stats: { instantaneous_ops_per_sec: '0' },
      },
      host: 'mycache.abc123.cache.amazonaws.com',
    });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.provider.provider).toBe('aws-elasticache');
    expect(result.provider.restrictions.length).toBeGreaterThan(0);
  });

  it('uses the default 30s duration when durationMs is omitted', async () => {
    const { service } = makeService({
      info: { stats: { instantaneous_ops_per_sec: '100' } },
    });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.throughput.durationMs).toBe(30_000);
    expect(result.throughput.estimatedLines).toBe(3_000); // 100 * 30
  });

  it('zeroes throughput fields when INFO stats are missing', async () => {
    const { service } = makeService({ info: {} });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.throughput).toMatchObject({
      opsPerSec: 0,
      inputKbps: 0,
      outputKbps: 0,
      estimatedLines: 0,
      estimatedBytes: 0,
    });
  });

  it('passes through the acl + health results unchanged', async () => {
    const acl = {
      username: 'reader',
      hasMonitor: false,
      setUserSnippet: 'ACL SETUSER reader +monitor',
    };
    const health = {
      allow: false,
      skipReason: 'memory_above_threshold',
      signals: { memoryPct: 0.95, oomEventsRecent: 0, replicationLagBytes: 0, failoverInProgress: false },
      thresholds: { memoryPctThreshold: 0.85, replicationLagThresholdBytes: 10485760 },
    };
    const { service } = makeService({
      info: { stats: { instantaneous_ops_per_sec: '0' } },
      acl,
      health,
    });
    const result = await service.run({ connectionId: CONNECTION_ID });
    expect(result.acl).toEqual(acl);
    expect(result.health).toEqual(health);
  });
});
