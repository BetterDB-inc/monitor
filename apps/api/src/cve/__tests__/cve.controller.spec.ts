import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CveScanResult, StoredCveDataset } from '@betterdb/shared';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { CveController } from '../cve.controller';
import { CveRefreshService } from '../cve-refresh.service';
import { CveDatasetUnavailableError, CveScanService } from '../cve-scan.service';
import { CveService } from '../cve.service';

const SCAN: CveScanResult = {
  connectionId: 'conn-1',
  fingerprint: 'fp-1',
  datasetVersion: 'ds-1',
  scannedAt: 10,
  lastCheckedAt: 20,
  topology: 'standalone',
  nodes: [],
  notScanned: [],
  drift: false,
  distinctVersions: ['8.0.9'],
  partial: false,
  missingSources: [],
};

const DATASET: StoredCveDataset = {
  datasetVersion: 'ds-1',
  refreshedAt: 5,
  advisories: [],
  snapshots: [
    {
      source: 'nvd',
      status: {
        source: 'nvd',
        state: 'empty',
        lastSuccessAt: 5,
        lastAttemptAt: 5,
        recordCount: 0,
        previousRecordCount: 14,
        query: 'cpe:2.3:a:lfprojects:valkey',
      },
      advisories: [],
      enrichment: [],
      lastGoodAdvisories: [],
      lastGoodEnrichment: [],
    },
  ],
};

describe('CveController', () => {
  const scanService = { getLatest: jest.fn(), scan: jest.fn() };
  const refreshService = { getDataset: jest.fn() };
  const connectionRegistry = { get: jest.fn(), getDefaultId: jest.fn() };
  let controller: CveController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [CveController],
      providers: [
        CveService,
        { provide: CveScanService, useValue: scanService },
        { provide: CveRefreshService, useValue: refreshService },
        { provide: ConnectionRegistry, useValue: connectionRegistry },
      ],
    }).compile();

    controller = moduleRef.get(CveController);
  });

  it('returns the stored scan without rescanning', async () => {
    scanService.getLatest.mockResolvedValue(SCAN);

    const result = await controller.getScan('conn-1');

    expect(result.fingerprint).toBe('fp-1');
    expect(scanService.scan).not.toHaveBeenCalled();
  });

  it('scans on demand when nothing is stored yet', async () => {
    scanService.getLatest.mockResolvedValue(null);
    scanService.scan.mockResolvedValue(SCAN);

    const result = await controller.getScan('conn-1');

    expect(scanService.scan).toHaveBeenCalledWith('conn-1');
    expect(result.fingerprint).toBe('fp-1');
  });

  it('forces a rescan on refresh', async () => {
    scanService.scan.mockResolvedValue(SCAN);

    await controller.refreshScan('conn-1');

    expect(scanService.scan).toHaveBeenCalledWith('conn-1', true);
  });

  it('resolves the default connection when no header is supplied', async () => {
    connectionRegistry.getDefaultId.mockReturnValue('conn-default');
    scanService.getLatest.mockResolvedValue(null);
    scanService.scan.mockResolvedValue(SCAN);

    await controller.getScan(undefined);
    await controller.refreshScan(undefined);

    expect(scanService.getLatest).toHaveBeenCalledWith('conn-default');
    expect(scanService.scan).toHaveBeenNthCalledWith(1, 'conn-default');
    expect(scanService.scan).toHaveBeenNthCalledWith(2, 'conn-default', true);
  });

  it('rejects a scan when no connection can be resolved', async () => {
    connectionRegistry.getDefaultId.mockReturnValue(null);

    await expect(controller.getScan(undefined)).rejects.toThrow(/No connection available/);
    await expect(controller.refreshScan(undefined)).rejects.toThrow(/No connection available/);
    expect(scanService.scan).not.toHaveBeenCalled();
    expect(scanService.getLatest).not.toHaveBeenCalled();
  });

  it('answers 503 while the advisory dataset has not been fetched yet', async () => {
    scanService.getLatest.mockResolvedValue(null);
    scanService.scan.mockRejectedValue(new CveDatasetUnavailableError());

    await expect(controller.getScan('conn-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.refreshScan('conn-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not mask an unrelated scan failure as unavailable', async () => {
    scanService.getLatest.mockResolvedValue(null);
    scanService.scan.mockRejectedValue(new Error('No node in this connection could be scanned'));

    await expect(controller.getScan('conn-1')).rejects.toThrow(
      'No node in this connection could be scanned',
    );
  });

  it('reports dataset age and per-source health', async () => {
    refreshService.getDataset.mockResolvedValue(DATASET);

    const status = await controller.getDataset();

    expect(status.datasetVersion).toBe('ds-1');
    expect(status.refreshedAt).toBe(5);
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0].state).toBe('empty');
    expect(status.sources[0].previousRecordCount).toBe(14);
    expect(status.healthy).toBe(false);
  });

  it('reports a healthy dataset when every source is ok', async () => {
    refreshService.getDataset.mockResolvedValue({
      ...DATASET,
      advisories: [],
      snapshots: [
        {
          ...DATASET.snapshots[0],
          status: { ...DATASET.snapshots[0].status, state: 'ok', recordCount: 14 },
        },
      ],
    });

    const status = await controller.getDataset();

    expect(status.healthy).toBe(true);
    expect(status.advisoryCount).toBe(0);
  });

  it('reports an absent dataset rather than pretending it is clean', async () => {
    refreshService.getDataset.mockResolvedValue(null);

    const status = await controller.getDataset();

    expect(status.datasetVersion).toBeNull();
    expect(status.sources).toEqual([]);
    expect(status.healthy).toBe(false);
  });

  it('does not call a dataset with no snapshots healthy', async () => {
    refreshService.getDataset.mockResolvedValue({ ...DATASET, snapshots: [] });

    const status = await controller.getDataset();

    expect(status.healthy).toBe(false);
  });

  it('serves the stored result instead of rescanning when refresh is hammered', async () => {
    scanService.scan.mockResolvedValue(SCAN);
    scanService.getLatest.mockResolvedValue(SCAN);

    const first = await controller.refreshScan('conn-1');
    const second = await controller.refreshScan('conn-1');

    expect(first).toEqual(SCAN);
    expect(second).toEqual(SCAN);
    expect(scanService.scan).toHaveBeenCalledTimes(1);
  });

  it('rescans anyway when the throttle window has nothing stored to serve', async () => {
    scanService.scan.mockResolvedValue(SCAN);
    scanService.getLatest.mockResolvedValue(null);

    await controller.refreshScan('conn-1');
    await controller.refreshScan('conn-1');

    expect(scanService.scan).toHaveBeenCalledTimes(2);
  });

  it('throttles each connection on its own clock', async () => {
    scanService.scan.mockResolvedValue(SCAN);
    scanService.getLatest.mockResolvedValue(SCAN);
    connectionRegistry.get.mockReturnValue({});

    await controller.refreshScan('conn-1');
    await controller.refreshScan('conn-2');

    expect(scanService.scan).toHaveBeenCalledTimes(2);
  });

  describe('when CVE_ENABLED is false', () => {
    beforeEach(() => {
      process.env.CVE_ENABLED = 'false';
    });

    afterEach(() => {
      delete process.env.CVE_ENABLED;
    });

    it('answers 503 on a scan rather than returning a stale stored result', async () => {
      scanService.getLatest.mockResolvedValue(SCAN);

      await expect(controller.getScan('conn-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(scanService.getLatest).not.toHaveBeenCalled();
    });

    it('answers 503 on a forced rescan instead of reaching the instance', async () => {
      await expect(controller.refreshScan('conn-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(scanService.scan).not.toHaveBeenCalled();
    });

    it('reports an empty corpus rather than a dataset it will never refresh', async () => {
      refreshService.getDataset.mockResolvedValue(DATASET);

      const status = await controller.getDataset();

      expect(status.datasetVersion).toBeNull();
      expect(status.advisoryCount).toBe(0);
      expect(status.sources).toEqual([]);
      expect(status.healthy).toBe(false);
    });
  });
});
