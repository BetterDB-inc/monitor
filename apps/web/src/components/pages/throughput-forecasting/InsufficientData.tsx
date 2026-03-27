import { Card } from '../../ui/card.tsx';
import { formatOps } from './utils.ts';
import { ThroughputForecast } from '@betterdb/shared';

export const InsufficientData = ({ forecast }: { forecast: ThroughputForecast }) => (
  <Card className="p-6">
    <p className="text-muted-foreground">{forecast.insufficientDataMessage}</p>
    {forecast.currentOpsPerSec > 0 && (
      <p className="mt-2 text-2xl font-semibold">{formatOps(forecast.currentOpsPerSec)} ops/sec</p>
    )}
  </Card>
);
