import { FleetService } from '../fleet.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { HealthService } from '../../health/health.service';
import { MetricsService } from '../../metrics/metrics.service';

function infoFixture(overrides: Record<string, unknown> = {}) {
  return {
    server: { uptime_in_seconds: '86400' },
    clients: { connected_clients: '42' },
    memory: { used_memory: '104857600', maxmemory: '536870912' },
    stats: { instantaneous_ops_per_sec: '1234' },
    replication: { role: 'master' },
    ...overrides,
  };
}

describe('FleetService', () => {
  let registry: { list: jest.Mock };
  let health: { getHealth: jest.Mock };
  let metrics: { getInfoParsed: jest.Mock };
  let service: FleetService;

  beforeEach(() => {
    registry = { list: jest.fn() };
    health = { getHealth: jest.fn() };
    metrics = { getInfoParsed: jest.fn() };
    service = new FleetService(
      registry as unknown as ConnectionRegistry,
      health as unknown as HealthService,
      metrics as unknown as MetricsService,
    );
  });

  it('returns waiting when no connections are registered', async () => {
    registry.list.mockReturnValue([]);
    const summary = await service.collectUncached();
    expect(summary.overallStatus).toBe('waiting');
    expect(summary.instances).toEqual([]);
  });

  it('maps healthy/degraded/down across 3 connections', async () => {
    registry.list.mockReturnValue([
      { id: 'c1', name: 'One', host: 'h1', port: 6379 },
      { id: 'c2', name: 'Two', host: 'h2', port: 6379 },
      { id: 'c3', name: 'Three', host: 'h3', port: 6379 },
    ]);
    health.getHealth.mockImplementation((id: string) => {
      if (id === 'c1') {
        return Promise.resolve({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
      }
      if (id === 'c2') {
        return Promise.resolve({ status: 'error', database: { type: 'unknown', version: null, host: 'h2', port: 6379 }, error: 'ping failed' });
      }
      return Promise.resolve({ status: 'disconnected', database: { type: 'unknown', version: null, host: 'h3', port: 6379 }, error: 'not connected' });
    });
    metrics.getInfoParsed.mockResolvedValue(infoFixture());

    const summary = await service.collectUncached();

    expect(summary.overallStatus).toBe('degraded');
    expect(summary.instances).toHaveLength(3);

    const up = summary.instances.find((i) => i.connectionId === 'c1')!;
    expect(up.status).toBe('up');
    expect(up.uptimeSec).toBe(86400);
    expect(up.memoryUsedBytes).toBe(104857600);
    expect(up.memoryMaxBytes).toBe(536870912);
    expect(up.memPct).toBeCloseTo(19.53, 1);
    expect(up.opsPerSec).toBe(1234);
    expect(up.connectedClients).toBe(42);
    expect(up.replicationRole).toBe('master');
    expect(up.lastSeen).toEqual(expect.any(Number));

    const down = summary.instances.find((i) => i.connectionId === 'c2')!;
    expect(down.status).toBe('down');
    expect(down.opsPerSec).toBeNull();
    expect(down.error).toBe('ping failed');
  });

  it('reports unhealthy when every instance is down', async () => {
    registry.list.mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]);
    health.getHealth.mockResolvedValue({ status: 'error', database: { type: 'unknown', version: null, host: 'h1', port: 6379 }, error: 'boom' });
    metrics.getInfoParsed.mockResolvedValue(infoFixture());

    const summary = await service.collectUncached();
    expect(summary.overallStatus).toBe('unhealthy');
    expect(summary.instances[0].status).toBe('down');
  });

  it('leaves memPct null when maxmemory is 0 (no limit)', async () => {
    registry.list.mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]);
    health.getHealth.mockResolvedValue({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
    metrics.getInfoParsed.mockResolvedValue(
      infoFixture({ memory: { used_memory: '104857600', maxmemory: '0' } }),
    );

    const summary = await service.collectUncached();
    expect(summary.instances[0].memPct).toBeNull();
    expect(summary.instances[0].memoryUsedBytes).toBe(104857600);
  });

  it('marks a hanging instance unknown without blocking the fleet', async () => {
    registry.list.mockReturnValue([
      { id: 'fast', name: 'Fast', host: 'h1', port: 6379 },
      { id: 'slow', name: 'Slow', host: 'h2', port: 6379 },
    ]);
    health.getHealth.mockImplementation((id: string) => {
      if (id === 'slow') {
        return new Promise(() => {});
      }
      return Promise.resolve({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
    });
    metrics.getInfoParsed.mockResolvedValue(infoFixture());

    const summary = await service.collectUncached();

    expect(summary.instances.find((i) => i.connectionId === 'fast')!.status).toBe('up');
    const slow = summary.instances.find((i) => i.connectionId === 'slow')!;
    expect(slow.status).toBe('unknown');
    expect(slow.error).toMatch(/Timed out/);
    expect(summary.overallStatus).toBe('degraded');
  }, 15000);

  it('prunes last-seen entries for removed connections', async () => {
    const lastSeenUp = (service as unknown as { lastSeenUp: Map<string, number> }).lastSeenUp;
    registry.list.mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]);
    health.getHealth.mockResolvedValue({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
    metrics.getInfoParsed.mockResolvedValue(infoFixture());

    await service.collectUncached();
    expect(lastSeenUp.size).toBe(1);

    registry.list.mockReturnValue([]);
    await service.collectUncached();
    expect(lastSeenUp.size).toBe(0);
  });

  it('caches the summary for subsequent calls', async () => {
    registry.list.mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]);
    health.getHealth.mockResolvedValue({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
    metrics.getInfoParsed.mockResolvedValue(infoFixture());

    const first = await service.getSummary();
    health.getHealth.mockResolvedValue({ status: 'error', database: { type: 'unknown', version: null, host: 'h1', port: 6379 }, error: 'flapped' });
    const second = await service.getSummary();

    expect(second).toBe(first);
    expect(second.instances[0].status).toBe('up');
  });

  it('ignores a late probe result after its timeout won the race', async () => {
    jest.useFakeTimers();
    try {
      registry.list.mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]);
      let resolveHealth!: (value: unknown) => void;
      let resolveInfo!: (value: unknown) => void;
      health.getHealth.mockReturnValue(new Promise((resolve) => { resolveHealth = resolve; }));
      metrics.getInfoParsed.mockReturnValue(new Promise((resolve) => { resolveInfo = resolve; }));

      const pending = service.collectUncached();
      await jest.advanceTimersByTimeAsync(5000);
      const timedOut = await pending;
      expect(timedOut.instances[0].status).toBe('unknown');

      // The orphaned probe settles late with a healthy result.
      resolveHealth({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } });
      resolveInfo(infoFixture());
      await Promise.resolve();
      await Promise.resolve();

      // A later collection while the instance is down must not see the
      // orphaned probe's timestamp as a last-seen value.
      health.getHealth.mockResolvedValue({ status: 'error', database: { type: 'unknown', version: null, host: 'h1', port: 6379 }, error: 'down' });
      metrics.getInfoParsed.mockResolvedValue(infoFixture());
      const later = await service.collectUncached();
      expect(later.instances[0].status).toBe('down');
      expect(later.instances[0].lastSeen).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
