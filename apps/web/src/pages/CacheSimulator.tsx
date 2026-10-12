import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { project, type CacheSimulatorSnapshot } from '@betterdb/shared';
import { cacheSimulatorApi, cacheSimulatorKeys } from '../api/cache-simulator';
import { useConnection } from '../hooks/useConnection';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { CurrentStateCard, HORIZONS, OutcomePanel, ProjectionInputs, measuredInputs, projectionInputs, type SimulatorInputs } from '../components/pages/cache-simulator';
import { ProjectionChart } from '../components/pages/cache-simulator/ProjectionChart';

const SIX_MONTHS = HORIZONS[HORIZONS.length - 1];

export function CacheSimulator() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  const queryClient = useQueryClient();
  const [horizon, setHorizon] = useState(HORIZONS[0]);
  const [overrides, setOverrides] = useState<SimulatorInputs | null>(null);

  const snapshot = useQuery({
    queryKey: cacheSimulatorKeys.snapshot(connectionId),
    queryFn: ({ signal }) => cacheSimulatorApi.getSnapshot(false, signal),
    refetchInterval: (query: { state: { data?: CacheSimulatorSnapshot } }) => (query.state.data?.status === 'sampling' ? 2000 : false),
  });

  const data = snapshot.data;
  const measured = useMemo(() => (data ? measuredInputs(data) : null), [data]);
  useEffect(() => setOverrides(null), [connectionId, data?.estimate?.sampledAt]);
  const inputs = overrides ?? measured;

  const projection = useMemo(() => (data && inputs ? project(projectionInputs(data, inputs, horizon.days)) : null), [data, inputs, horizon]);
  const sizing = useMemo(() => (data && inputs ? project(projectionInputs(data, inputs, SIX_MONTHS.days)) : null), [data, inputs]);

  const refresh = async () => {
    const next = await cacheSimulatorApi.getSnapshot(true);
    queryClient.setQueryData(cacheSimulatorKeys.snapshot(connectionId), next);
  };

  if (!data || !inputs || !projection || !sizing) {
    return snapshot.isError ? (
      <p className="text-sm text-destructive">Could not load the cache size simulator</p>
    ) : (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const maxmemory = inputs.maxmemory > 0 ? inputs.maxmemory : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cache Size Simulator</h1>
        <Button variant="outline" size="sm" onClick={refresh} disabled={data.status === 'sampling'}>
          Refresh sample
        </Button>
      </div>
      <CurrentStateCard snapshot={data} />
      <ProjectionInputs inputs={inputs} hasGrowth={data.growth !== null} onChange={setOverrides} onReset={() => setOverrides(null)} />
      <div className="flex gap-2">
        {HORIZONS.map((entry) => (
          <Button key={entry.label} size="sm" variant={entry.label === horizon.label ? 'default' : 'outline'} onClick={() => setHorizon(entry)}>
            {entry.label}
          </Button>
        ))}
      </div>
      <ProjectionChart projection={projection} maxmemory={maxmemory} />
      <OutcomePanel projection={projection} sizingProjection={sizing} maxmemory={maxmemory} policy={data.instant.maxmemoryPolicy} horizonLabel={horizon.label === '6m' ? '6 months' : `${horizon.days} days`} />
    </div>
  );
}
