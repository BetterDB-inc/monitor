const SIZE_GB = 1_073_741_824;

const SIZE_MB = 1_048_576;

const SIZE_KB = 1_024;

function formatNumber(value: number, formatter: 'bytes' | 'percent' | 'ratio' | 'ops'): string {
  switch (formatter) {
    case 'bytes':
      if (value >= SIZE_GB) {
        return `${(value / SIZE_GB).toFixed(1)} GB`;
      }
      if (value >= SIZE_MB) {
        return `${(value / SIZE_MB).toFixed(1)} MB`;
      }
      if (value >= SIZE_KB) {
        return `${(value / SIZE_KB).toFixed(1)} KB`;
      }
      return `${value} B`;
    case 'percent':
      return `${value.toFixed(1)}`;
    case 'ratio':
      return `${value.toFixed(2)}`;
    case 'ops':
      if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
      }
      if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
      }
      return `${Math.round(value)}`;
  }
}

const UNIT_SUFFIX = {
  bytes: '',
  percent: '%',
  ratio: 'x',
  ops: ' ops/sec',
} as const;

export function formatMetricValue(
  value: number,
  formatter: 'bytes' | 'percent' | 'ratio' | 'ops',
): string {
  return `${formatNumber(value, formatter)}${UNIT_SUFFIX[formatter]}`;
}

export function formatGrowthRate(
  rate: number,
  formatter: 'bytes' | 'percent' | 'ratio' | 'ops',
): string {
  const sign = rate >= 0 ? '+' : '-';
  return `${sign}${formatNumber(Math.abs(rate), formatter)}/hr`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
