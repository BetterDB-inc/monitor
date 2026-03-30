import type { MetricKindMeta } from '@betterdb/shared';
import { Card } from '../../ui/card';

export function MetricDisabled({ meta }: { meta: MetricKindMeta }) {
  return (
    <Card className="p-6 text-center text-muted-foreground">
      <p>{meta.label} forecasting is disabled for this connection.</p>
      <p className="text-sm mt-2">Enable it in the settings panel below.</p>
    </Card>
  );
}
