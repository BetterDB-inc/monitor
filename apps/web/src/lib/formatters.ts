import { formatBytes } from './utils';

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

export function formatValue(value: number, metric: string): string {
  if (metric === 'replication_divergence') return formatBytes(value);
  if (metric === 'memory_used' || metric === 'memory_overhead') {
    if (value > 1e9) return `${(value / 1e9).toFixed(2)} GB`;
    if (value > 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    return `${(value / 1e3).toFixed(0)} KB`;
  }
  // Percentage-valued events (value/baseline/threshold are all percentages).
  if (metric === 'load_saturation' || metric === 'fork_memory_risk') {
    return `${value.toFixed(1)}%`;
  }
  if (metric === 'fragmentation_ratio') return value.toFixed(2);
  if (metric === 'retry_amplification') return `${value.toFixed(1)}×`;
  if (metric === 'command_p99') {
    // Stored in microseconds; show ms once past 1ms, else µs.
    return value >= 1000 ? `${(value / 1000).toFixed(1)} ms` : `${Math.round(value)} µs`;
  }
  if (value > 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value > 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
