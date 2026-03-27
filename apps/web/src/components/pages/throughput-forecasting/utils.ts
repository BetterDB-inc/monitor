export const WINDOW_PRESETS = [
  { label: '1h', value: 3600000 },
  { label: '3h', value: 10800000 },
  { label: '6h', value: 21600000 },
  { label: '12h', value: 43200000 },
  { label: '24h', value: 86400000 },
];

export const ALERT_PRESETS = [
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
  { label: '2h', value: 7200000 },
  { label: '4h', value: 14400000 },
];

export function formatOps(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
