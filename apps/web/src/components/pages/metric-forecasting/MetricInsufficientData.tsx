import type { MetricForecast, MetricKindMeta } from '@betterdb/shared';
import { Card } from '../../ui/card';
import { formatMetricValue } from './formatters';

export function MetricInsufficientData({
  forecast,
  meta,
}: {
  forecast: MetricForecast;
  meta: MetricKindMeta;
}) {
  return (
    <Card className="p-6">
      <p className="text-center text-primary">
        {forecast.insufficientDataMessage}
      </p>
      <p className="text-center text-2xl font-bold mt-4">
        {formatMetricValue(forecast.currentValue, meta.valueFormatter)}
      </p>
    </Card>
  );
}
