import { useQuery } from '@tanstack/react-query';
import { useConnection } from '../hooks/useConnection';
import { scalingReadinessApi } from '../api/scaling-readiness';
import { ReadinessBreakdown, ReadinessHeader } from '../components/pages/scaling-readiness';

export function ScalingReadiness() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const { data: readiness, isLoading } = useQuery({
    queryKey: ['scaling-readiness', connectionId],
    queryFn: ({ signal }) => scalingReadinessApi.get(signal),
    enabled: !!connectionId,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Scaling Readiness</h1>
      {isLoading && !readiness ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : readiness ? (
        <>
          <ReadinessHeader readiness={readiness} />
          <ReadinessBreakdown dimensions={readiness.dimensions} />
        </>
      ) : null}
    </div>
  );
}
