import type { MetricKindMeta } from '@betterdb/shared';
import { EmptyState } from '../../ui/empty-state';

export function MetricDisabled({ meta }: { meta: MetricKindMeta }) {
  return (
    <EmptyState
      title={`${meta.label} forecasting is disabled for this connection`}
      description="Enable it in the settings panel below."
    />
  );
}
