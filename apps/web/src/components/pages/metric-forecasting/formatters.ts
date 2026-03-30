export function formatMetricValue(
  value: number,
  formatter: 'bytes' | 'percent' | 'ratio' | 'ops',
): string {
  switch (formatter) {
    case 'bytes':
      if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
      if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
      if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
      return `${value} B`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'ratio':
      return `${value.toFixed(2)}x`;
    case 'ops':
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
      return `${Math.round(value)}`;
  }
}

export function formatGrowthRate(
  rate: number,
  formatter: 'bytes' | 'percent' | 'ratio' | 'ops',
): string {
  const sign = rate >= 0 ? '+' : '-';
  return `${sign}${formatMetricValue(Math.abs(rate), formatter)}/hr`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
