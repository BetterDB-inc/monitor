import type { MetricForecast, MetricKindMeta } from '@betterdb/shared';
import { Card } from '../../ui/card';
import { formatMetricValue, formatGrowthRate } from './formatters';

const TREND_COLORS = {
  rising: 'text-red-600 dark:text-red-400',
  falling: 'text-green-600 dark:text-green-400',
  stable: 'text-blue-600 dark:text-blue-400',
} as const;

export function MetricForecastCard({
  forecast,
  meta,
}: {
  forecast: MetricForecast;
  meta: MetricKindMeta;
}) {
  return (
    <Card className="p-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Current</p>
          <p className="text-2xl font-bold">
            {formatMetricValue(forecast.currentValue, meta.valueFormatter)}
          </p>
          <p className="text-xs text-muted-foreground">{meta.label}</p>
        </div>

        <div>
          <p className="text-sm text-muted-foreground">Trend</p>
          <p className={`text-2xl font-bold ${TREND_COLORS[forecast.trendDirection]}`}>
            {forecast.trendDirection}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatGrowthRate(forecast.growthRate, meta.valueFormatter)}
          </p>
        </div>

        <div>
          <p className="text-sm text-muted-foreground">
            {forecast.mode === 'forecast' ? 'Time to Ceiling' : 'Growth'}
          </p>
          <p className="text-2xl font-bold">{forecast.timeToLimitHuman || '—'}</p>
          {forecast.ceiling !== null && (
            <p className="text-xs text-muted-foreground">
              Ceiling: {formatMetricValue(forecast.ceiling, meta.valueFormatter)}
            </p>
          )}
        </div>

        <div>
          <p className="text-sm text-muted-foreground">Data Points</p>
          <p className="text-2xl font-bold">{forecast.dataPointCount}</p>
          <p className="text-xs text-muted-foreground">
            {(forecast.windowMs / 3_600_000).toFixed(0)}h window
          </p>
        </div>
      </div>
    </Card>
  );
}
