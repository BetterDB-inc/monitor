import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CveDatasetStatus, CveScanResult, CveSourceStatus } from '@betterdb/shared';
import { CveRefreshService } from './cve-refresh.service';
import { CveDatasetUnavailableError, CveScanService } from './cve-scan.service';

function absentDatasetStatus(): CveDatasetStatus {
  return {
    datasetVersion: null,
    refreshedAt: null,
    advisoryCount: 0,
    sources: [],
    healthy: false,
  };
}

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

    return this.runScan(connectionId, false);
  }

  async refreshScan(connectionId: string): Promise<CveScanResult> {
    return this.runScan(connectionId, true);
  }

  async getDataset(): Promise<CveDatasetStatus> {
    const dataset = await this.refreshService.getDataset();
    if (dataset === null) {
      return absentDatasetStatus();
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

  private async runScan(connectionId: string, force: boolean): Promise<CveScanResult> {
    try {
      if (force === true) {
        return await this.scanService.scan(connectionId, true);
      }

      return await this.scanService.scan(connectionId);
    } catch (error: unknown) {
      if (error instanceof CveDatasetUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }

      throw error;
    }
  }
}
