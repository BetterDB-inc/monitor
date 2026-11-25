import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Feature, type PlacementMode, type PlacementStatus } from '@betterdb/shared';
import { placementApi } from '../api/placement';
import { useLicense } from './useLicense';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 15_000;

export const placementQueryKey = (connectionId: string | undefined) => ['placement', connectionId];

export function usePlacement(connectionId: string | undefined, enabled = true) {
  const { hasFeature } = useLicense();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const queryClient = useQueryClient();
  const { data, error } = usePolling<PlacementStatus>({
    fetcher: (signal) => placementApi.get(connectionId as string, signal),
    interval: POLL_INTERVAL_MS,
    enabled: enabled && licensed && !!connectionId,
    queryKey: placementQueryKey(connectionId),
  });
  const {
    mutate,
    reset,
    isPending,
    error: modeError,
  } = useMutation<PlacementStatus, Error, PlacementMode>({
    mutationFn: (mode) => placementApi.setMode(connectionId as string, mode),
    onSuccess: async (status) => {
      await queryClient.cancelQueries({ queryKey: placementQueryKey(connectionId) });
      queryClient.setQueryData(placementQueryKey(connectionId), status);
    },
  });

  useEffect(() => reset, [connectionId, reset]);

  return {
    licensed,
    status: enabled && licensed && connectionId ? (data ?? undefined) : undefined,
    error,
    setMode: (mode: PlacementMode) => {
      if (connectionId) mutate(mode);
    },
    saving: isPending,
    modeError,
  };
}
