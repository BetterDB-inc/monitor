import { Link } from 'react-router-dom';
import { ANOMALY_DETECTOR_METRICS, Feature } from '@betterdb/shared';
import { useCanMutate } from '../../hooks/useCanMutate';
import { useLicense } from '../../hooks/useLicense';
import { Button } from '../ui/button';

export function ThresholdsLink({ metricType }: { metricType: string }) {
  const canMutate = useCanMutate();
  const { hasFeature } = useLicense();
  if (
    canMutate === false ||
    !hasFeature(Feature.ANOMALY_DETECTION) ||
    !(ANOMALY_DETECTOR_METRICS as readonly string[]).includes(metricType)
  ) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="ghost">
      <Link
        to={`/settings?section=anomaly&metric=${metricType}`}
        onClick={(e) => e.stopPropagation()}
      >
        Thresholds
      </Link>
    </Button>
  );
}
