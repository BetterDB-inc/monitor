export function formatTtlSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return '0s';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const minutes = seconds / 60;
    return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
  }
  if (seconds < 86400) {
    const hours = seconds / 3600;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  const days = seconds / 86400;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

export function formatTimeAgo(epochMs: number, now: number = Date.now()): string {
  const deltaMs = now - epochMs;
  if (deltaMs < 0) {
    return 'in the future';
  }
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatExpiresIn(expiresAtMs: number, now: number = Date.now()): string {
  const remainingMs = expiresAtMs - now;
  if (remainingMs <= 0) {
    return 'Expired';
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds < 60) {
    return `Expires in ${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `Expires in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Expires in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `Expires in ${days}d`;
}
