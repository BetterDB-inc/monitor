import type { CveDatasetStatus, CveScanResult } from '@betterdb/shared';
import { fetchApi } from './client';

export async function fetchCveScan(): Promise<CveScanResult> {
  return fetchApi<CveScanResult>('/cve/scan');
}

export async function refreshCveScan(): Promise<CveScanResult> {
  return fetchApi<CveScanResult>('/cve/scan/refresh', { method: 'POST' });
}

export async function fetchCveDataset(): Promise<CveDatasetStatus> {
  return fetchApi<CveDatasetStatus>('/cve/dataset');
}
