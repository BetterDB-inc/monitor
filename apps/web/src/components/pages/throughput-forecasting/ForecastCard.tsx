import type { ThroughputForecast } from '@betterdb/shared';
import { Card } from '../../ui/card.tsx';
import { formatOps } from './utils.ts';

export function ForecastCard({ forecast }: { forecast: ThroughputForecast }) {
  const directionArrow =
    forecast.trendDirection === 'rising'
      ? '\u2197'
      : forecast.trendDirection === 'falling'
        ? '\u2198'
        : '\u2192';

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-3">
        {forecast.mode === 'forecast' ? 'Throughput Forecast' : 'Throughput Trend'}
      </h2>

      {forecast.mode === 'forecast' && forecast.timeToLimitHuman && (
        <p className="text-2xl font-bold mb-4">{forecast.timeToLimitHuman}</p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <p className="text-muted-foreground">Current</p>
          <p className="font-semibold">{formatOps(forecast.currentOpsPerSec)} ops/sec</p>
        </div>
        {forecast.opsCeiling && (
          <div>
            <p className="text-muted-foreground">Ceiling</p>
            <p className="font-semibold">{formatOps(forecast.opsCeiling)} ops/sec</p>
          </div>
        )}
        <div>
          <p className="text-muted-foreground">Growth Rate</p>
          <p className="font-semibold">
            {forecast.growthRate >= 0 ? '+' : ''}
            {formatOps(Math.round(forecast.growthRate))}/hr
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Trend</p>
          <p className="font-semibold">
            {directionArrow} {forecast.trendDirection} ({forecast.growthPercent >= 0 ? '+' : ''}
            {forecast.growthPercent.toFixed(1)}%)
          </p>
        </div>
      </div>
    </Card>
  );
}
