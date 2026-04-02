import { useQuery } from '@tanstack/react-query';
import { fetchApi } from '../api/client';
import type { TelemetryClient } from '../telemetry/telemetry-client.interface';
import { ApiTelemetryClient } from '../telemetry/clients/api-telemetry-client';
import { PosthogTelemetryClient } from '../telemetry/clients/posthog-telemetry-client';

interface TelemetryConfig {
  instanceId: string;
  telemetryEnabled: boolean;
  provider: string;
}

interface TelemetryState {
  client: TelemetryClient;
  ready: boolean;
}

const clientsMap = new Map<string, TelemetryClient>();
clientsMap.set('http', new ApiTelemetryClient());

function createClient(config: TelemetryConfig): TelemetryClient {
  if (!config.telemetryEnabled) {
    return clientsMap.get('http')!;
  }

  switch (config.provider) {
    case 'posthog': {
      if (clientsMap.has('posthog')) {
        return clientsMap.get('posthog')!;
      }
      const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
      const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
      if (!apiKey) {
        return clientsMap.get('http')!;
      }
      clientsMap.set('posthog', new PosthogTelemetryClient(apiKey, host));
      return clientsMap.get('posthog')!;
    }
    case 'http':
    default:
      return clientsMap.get('http')!;
  }
}

export function useTelemetry(): TelemetryState {
  const {
    data: config,
    isSuccess,
    isError,
  } = useQuery<TelemetryConfig>({
    queryKey: ['telemetry-config'],
    queryFn: () => fetchApi<TelemetryConfig>('/telemetry/config'),
    staleTime: 30 * 60 * 1000,
  });

  const client = config ? createClient(config) : clientsMap.get('http')!;

  return { client, ready: isSuccess || isError };
}
