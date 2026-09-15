import { FleetService } from '../fleet.service';

function infoFixture() {
  return {
    server: { uptime_in_seconds: '86400' },
    clients: { connected_clients: '42' },
    memory: { used_memory: '104857600', maxmemory: '536870912' },
    stats: { instantaneous_ops_per_sec: '1234' },
    replication: { role: 'master' },
  };
}

function scanFixture() {
  return {
    connectionId: 'c1',
    fingerprint: 'fp1',
    datasetVersion: 'ds-1',
    scannedAt: 1,
    lastCheckedAt: 1,
    topology: 'standalone',
    nodes: [
      {
        nodeId: 'c1',
        address: 'h1:6379',
        role: 'standalone',
        product: 'valkey',
        engineVersion: '8.0.9',
        modules: [],
        findings: [
          {
            advisory: {
              cveId: 'CVE-2026-00001',
              severity: 'critical',
              knownExploited: true,
            },
            matchedOn: 'engine',
            matchedVersion: '8.0.9',
          },
          {
            advisory: {
              cveId: 'CVE-2026-00002',
              severity: 'high',
              knownExploited: false,
            },
            matchedOn: 'engine',
            matchedVersion: '8.0.9',
          },
        ],
        unversioned: [],
        severityCounts: { critical: 1, high: 1, medium: 0, low: 0 },
      },
    ],
    notScanned: [],
    drift: false,
    distinctVersions: ['8.0.9'],
    partial: false,
    missingSources: [],
  };
}

describe('FleetService CVE rollup', () => {
  it('attaches critical/kev counts from the latest scan', async () => {
    const registry = { list: jest.fn().mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]) };
    const health = {
      getHealth: jest.fn().mockResolvedValue({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } }),
    };
    const metrics = { getInfoParsed: jest.fn().mockResolvedValue(infoFixture()) };
    const storage = { getCveScanResult: jest.fn().mockResolvedValue(scanFixture()) };
    const service = new FleetService(
      registry as never,
      health as never,
      metrics as never,
      storage as never,
    );

    const summary = await service.collectUncached();

    expect(summary.instances[0].cve).toEqual({
      critical: 1,
      kev: 1,
      fingerprint: 'fp1',
      stale: false,
    });
  });

  it('returns null CVE when never scanned and does not fail when storage throws', async () => {
    const registry = { list: jest.fn().mockReturnValue([{ id: 'c1', name: 'One', host: 'h1', port: 6379 }]) };
    const health = {
      getHealth: jest.fn().mockResolvedValue({ status: 'connected', database: { type: 'valkey', version: '8.0', host: 'h1', port: 6379 } }),
    };
    const metrics = { getInfoParsed: jest.fn().mockResolvedValue(infoFixture()) };
    const storage = {
      getCveScanResult: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const service = new FleetService(
      registry as never,
      health as never,
      metrics as never,
      storage as never,
    );

    const summary = await service.collectUncached();

    expect(summary.instances[0].cve).toBeNull();
  });
});
