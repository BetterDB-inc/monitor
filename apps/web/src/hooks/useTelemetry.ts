import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchApi } from '../api/client';
import type { TelemetryClient } from '../telemetry/telemetry-client.interface';
import { ApiTelemetryClient } from '../telemetry/clients/api-telemetry-client';
import { NoopTelemetryClient } from '../telemetry/clients/noop-telemetry-client';

interface TelemetryConfig {
  instanceId: string;
  telemetryEnabled: boolean;
  provider: string;
}

interface TelemetryState {
  client: TelemetryClient;
  ready: boolean;
}

function createClient(config: TelemetryConfig): TelemetryClient {
  if (!config.telemetryEnabled || config.provider === 'noop') {
    return new NoopTelemetryClient();
  }

  switch (config.provider) {
    case 'posthog':
      // PosthogTelemetryClient will be added in #76
      return new ApiTelemetryClient();
    case 'http':
    default:
      return new ApiTelemetryClient();
  }
}

const noopClient = new NoopTelemetryClient();
const fallbackClient = new ApiTelemetryClient();

export function useTelemetry(): TelemetryState {
  const { data: config, isSuccess, isError } = useQuery<TelemetryConfig>({
    queryKey: ['telemetry-config'],
    queryFn: () => fetchApi<TelemetryConfig>('/telemetry/config'),
    staleTime: Infinity,
    retry: false,
  });

  const client = useMemo(() => {
    if (isError) return fallbackClient;
    if (!config) return noopClient;

    const newClient = createClient(config);
    if (config.instanceId) {
      newClient.identify(config.instanceId, { provider: config.provider });
    }
    return newClient;
  }, [config, isError]);

  return { client, ready: isSuccess || isError };
}
