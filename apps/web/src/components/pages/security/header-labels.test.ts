import { describe, expect, it } from 'vitest';
import { datasetAgeLabel, scanAgeLabel } from './header-labels';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('datasetAgeLabel', () => {
  it('says the advisories were never refreshed when there is no timestamp', () => {
    expect(datasetAgeLabel(null)).toBe('advisories never refreshed');
    expect(datasetAgeLabel(undefined)).toBe('advisories never refreshed');
  });

  it('reports the dataset age in hours', () => {
    expect(datasetAgeLabel(Date.now() - 3 * HOUR)).toBe('advisories refreshed 3h ago');
  });
});

describe('scanAgeLabel', () => {
  it('reports the age of the stored scan, not of the dataset', () => {
    const scannedAt = Date.now() - 26 * HOUR;

    expect(scanAgeLabel(scannedAt, scannedAt)).toBe('scanned 1d ago');
  });

  it('reports minutes for a recent scan', () => {
    const scannedAt = Date.now() - 5 * MINUTE;

    expect(scanAgeLabel(scannedAt, scannedAt)).toBe('scanned 5m ago');
  });

  it('distinguishes when the result was last confirmed from when it was produced', () => {
    const label = scanAgeLabel(Date.now() - 5 * HOUR, Date.now() - HOUR);

    expect(label).toBe('scanned 5h ago, rechecked 1h ago');
  });
});
