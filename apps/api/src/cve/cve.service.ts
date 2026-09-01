import { Injectable } from '@nestjs/common';
import type { CveDatasetStatus, CveScanResult, CveSourceStatus } from '@betterdb/shared';
import { CveRefreshService } from './cve-refresh.service';
import { CveScanService } from './cve-scan.service';

const ABSENT_DATASET: CveDatasetStatus = {
  datasetVersion: null,
  refreshedAt: null,
  advisoryCount: 0,
  sources: [],
  healthy: false,
};

@Injectable()
export class CveService {
  constructor(
    private readonly scanService: CveScanService,
    private readonly refreshService: CveRefreshService,
  ) {}

  async getScan(connectionId: string): Promise<CveScanResult> {
    const stored = await this.scanService.getLatest(connectionId);
    if (stored !== null) {
      return stored;
    }

    return this.scanService.scan(connectionId);
  }

  async refreshScan(connectionId: string): Promise<CveScanResult> {
    return this.scanService.scan(connectionId, true);
  }

  async getDataset(): Promise<CveDatasetStatus> {
    const dataset = await this.refreshService.getDataset();
    if (dataset === null) {
      return { ...ABSENT_DATASET };
    }

    const sources: CveSourceStatus[] = dataset.snapshots.map((snapshot) => {
      return snapshot.status;
    });
    const allOk = sources.every((status) => {
      return status.state === 'ok';
    });

    return {
      datasetVersion: dataset.datasetVersion,
      refreshedAt: dataset.refreshedAt,
      advisoryCount: dataset.advisories.length,
      sources,
      healthy: sources.length > 0 && allOk,
    };
  }
}
