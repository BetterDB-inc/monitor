const MINUTE_MS = 60_000;

function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / MINUTE_MS);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

export function datasetAgeLabel(refreshedAt: number | null | undefined): string {
  if (refreshedAt === null || refreshedAt === undefined) {
    return 'advisories never refreshed';
  }

  return `advisories refreshed ${ago(refreshedAt)}`;
}

export function scanAgeLabel(scannedAt: number, lastCheckedAt: number): string {
  const scanned = `scanned ${ago(scannedAt)}`;

  if (lastCheckedAt - scannedAt < MINUTE_MS) {
    return scanned;
  }

  return `${scanned}, rechecked ${ago(lastCheckedAt)}`;
}
