import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import type { StoragePort } from '../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-1';
const INSTANCE = { host: '10.0.0.1', port: 6379 };

function scanFixture(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    fingerprint: 'fp1',
    datasetVersion: 'ds-1',
    scannedAt: 1,
    lastCheckedAt: 1,
    topology: 'standalone',
    nodes: [
      {
        nodeId: CONNECTION_ID,
        address: '10.0.0.1:6379',
        role: 'standalone',
        product: 'valkey',
        engineVersion: '8.0.9',
        modules: [],
        findings: [
          {
            advisory: { cveId: 'CVE-2026-00001', severity: 'critical', knownExploited: true },
            matchedOn: 'engine',
            matchedVersion: '8.0.9',
          },
        ],
        unversioned: [],
        severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      },
    ],
    notScanned: [],
    drift: false,
    distinctVersions: ['8.0.9'],
    partial: false,
    missingSources: [],
    ...overrides,
  };
}

describe('PrometheusService CVE metrics', () => {
  let storage: { getCveScanResult: jest.Mock };
  let service: PrometheusService;

  function buildService() {
    storage = { getCveScanResult: jest.fn() };
    const registry = {
      getConfig: jest.fn().mockReturnValue(INSTANCE),
      list: jest.fn().mockReturnValue([]),
      getName: jest.fn().mockReturnValue('primary'),
    } as unknown as ConnectionRegistry;
    service = new PrometheusService(
      storage as unknown as StoragePort,
      registry,
      { get: jest.fn().mockReturnValue(5000) } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    return service;
  }

  async function gaugeValue(name: string, labels: Record<string, string>): Promise<number | null> {
    const metric = (service as unknown as { registry: { getSingleMetric: (n: string) => unknown } }).registry.getSingleMetric(
      name,
    ) as { get: () => Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> };
    const { values } = await metric.get();
    const entry = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
    return entry ? entry.value : null;
  }

  it('exports critical/kev/stale gauges from the latest scan', async () => {
    buildService();
    storage.getCveScanResult.mockResolvedValue(scanFixture());

    await (service as unknown as { updateCveMetrics: (c: string, l: string) => Promise<void> }).updateCveMetrics(
      CONNECTION_ID,
      '10.0.0.1:6379',
    );

    expect(await gaugeValue('betterdb_cve_findings', { connection: '10.0.0.1:6379', severity: 'critical' })).toBe(1);
    expect(await gaugeValue('betterdb_cve_findings', { connection: '10.0.0.1:6379', severity: 'high' })).toBe(0);
    expect(await gaugeValue('betterdb_cve_kev', { connection: '10.0.0.1:6379' })).toBe(1);
    expect(await gaugeValue('betterdb_cve_dataset_stale', { connection: '10.0.0.1:6379' })).toBe(0);
  });

  it('handles legacy scans without missingSources (no crash, not stale)', async () => {
    buildService();
    const legacy = scanFixture();
    delete (legacy as Record<string, unknown>).missingSources;
    storage.getCveScanResult.mockResolvedValue(legacy);

    await (service as unknown as { updateCveMetrics: (c: string, l: string) => Promise<void> }).updateCveMetrics(
      CONNECTION_ID,
      '10.0.0.1:6379',
    );

    expect(await gaugeValue('betterdb_cve_findings', { connection: '10.0.0.1:6379', severity: 'critical' })).toBe(1);
    expect(await gaugeValue('betterdb_cve_dataset_stale', { connection: '10.0.0.1:6379' })).toBe(0);
  });

  it('removes CVE series when the scan disappears and on connection cleanup', async () => {
    buildService();
    storage.getCveScanResult.mockResolvedValue(scanFixture());
    const update = (service as unknown as { updateCveMetrics: (c: string, l: string) => Promise<void> }).updateCveMetrics.bind(service);

    await update(CONNECTION_ID, '10.0.0.1:6379');
    expect(await gaugeValue('betterdb_cve_kev', { connection: '10.0.0.1:6379' })).toBe(1);

    storage.getCveScanResult.mockResolvedValue(null);
    await update(CONNECTION_ID, '10.0.0.1:6379');
    expect(await gaugeValue('betterdb_cve_kev', { connection: '10.0.0.1:6379' })).toBeNull();

    storage.getCveScanResult.mockResolvedValue(scanFixture());
    await update(CONNECTION_ID, '10.0.0.1:6379');
    expect(await gaugeValue('betterdb_cve_kev', { connection: '10.0.0.1:6379' })).toBe(1);

    service.cleanupConnectionMetrics(CONNECTION_ID);
    expect(await gaugeValue('betterdb_cve_kev', { connection: '10.0.0.1:6379' })).toBeNull();
    expect(
      await gaugeValue('betterdb_cve_findings', { connection: '10.0.0.1:6379', severity: 'critical' }),
    ).toBeNull();
    expect(await gaugeValue('betterdb_cve_dataset_stale', { connection: '10.0.0.1:6379' })).toBeNull();
  });
});
