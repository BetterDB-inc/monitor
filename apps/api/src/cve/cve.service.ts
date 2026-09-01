import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CveDatasetStatus, CveScanResult, CveSourceStatus } from '@betterdb/shared';
import { CVE_SCAN_MIN_FORCE_INTERVAL_MS, cveDisabledByConfig, ghsaToken } from './cve.constants';
import { CveRefreshService } from './cve-refresh.service';
import {
  CveConnectionUnreachableError,
  CveDatasetUnavailableError,
  CveScanService,
} from './cve-scan.service';

export const CVE_DISABLED_MESSAGE =
  'CVE inspection is turned off on this install (CVE_ENABLED=false), so nothing was scanned.';

function absentDatasetStatus(): CveDatasetStatus {
  return {
    datasetVersion: null,
    refreshedAt: null,
    advisoryCount: 0,
    sources: [],
    healthy: false,
    ghsaAuthenticated: ghsaToken() !== undefined,
  };
}

@Injectable()
export class CveService {
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(
    private readonly scanService: CveScanService,
    private readonly refreshService: CveRefreshService,
  ) {}

  async getScan(connectionId: string): Promise<CveScanResult> {
    if (cveDisabledByConfig() === true) {
      throw new ServiceUnavailableException(CVE_DISABLED_MESSAGE);
    }

    const stored = await this.scanService.getLatest(connectionId);
    if (stored !== null) {
      return stored;
    }

    return this.runScan(connectionId, false);
  }

  async refreshScan(connectionId: string): Promise<CveScanResult> {
    if (cveDisabledByConfig() === true) {
      throw new ServiceUnavailableException(CVE_DISABLED_MESSAGE);
    }

    const throttled = await this.throttledScan(connectionId);
    if (throttled !== null) {
      return throttled;
    }

    this.lastRefreshAt.set(connectionId, Date.now());

    return this.runScan(connectionId, true);
  }

  async getDataset(): Promise<CveDatasetStatus> {
    if (cveDisabledByConfig() === true) {
      return absentDatasetStatus();
    }

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
      ghsaAuthenticated: ghsaToken() !== undefined,
    };
  }

  private async throttledScan(connectionId: string): Promise<CveScanResult | null> {
    const previous = this.lastRefreshAt.get(connectionId);

    if (previous === undefined || Date.now() - previous >= CVE_SCAN_MIN_FORCE_INTERVAL_MS) {
      return null;
    }

    return this.scanService.getLatest(connectionId);
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

      if (error instanceof CveConnectionUnreachableError) {
        throw new ServiceUnavailableException(error.message);
      }

      throw error;
    }
  }
}
