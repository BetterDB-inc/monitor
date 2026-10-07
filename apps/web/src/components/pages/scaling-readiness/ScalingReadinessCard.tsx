import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ScalingReadiness } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { useConnection } from '../../../hooks/useConnection';
import { scalingReadinessApi } from '../../../api/scaling-readiness';
import { BAND_STYLES } from './band';

export function ScalingReadinessCardView({
  readiness,
  isLoading,
  isError,
}: {
  readiness: ScalingReadiness | undefined;
  isLoading: boolean;
  isError?: boolean;
}) {
  const band = readiness?.band ? BAND_STYLES[readiness.band] : null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Scaling Readiness</CardTitle>
        <Link to="/scaling-readiness" className="text-sm text-primary hover:underline">
          View details →
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading && !readiness ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError && !readiness ? (
          <p className="text-sm text-destructive">Could not load scaling readiness</p>
        ) : readiness?.score == null || !band ? (
          <p className="text-sm text-muted-foreground">{readiness?.summary ?? 'Not enough data yet'}</p>
        ) : (
          <div className="flex items-center gap-4">
            <span className={`text-3xl font-bold ${band.text}`}>{readiness.score}</span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${band.badge}`}>{band.label}</span>
            <p className="text-sm text-muted-foreground">{readiness.summary}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ScalingReadinessCard() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['scaling-readiness', connectionId],
    queryFn: ({ signal }) => scalingReadinessApi.get(signal),
    enabled: !!connectionId,
    refetchInterval: 60_000,
  });
  return <ScalingReadinessCardView readiness={data} isLoading={isLoading} isError={isError} />;
}
