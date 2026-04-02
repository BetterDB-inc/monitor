import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchApi } from '../api/client';
import type { TelemetryClient } from '../telemetry/telemetry-client.interface';
import { ApiTelemetryClient } from '../telemetry/clients/api-telemetry-client';
import { NoopTelemetryClient } from '../telemetry/clients/noop-telemetry-client';
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

function createClient(config: TelemetryConfig): TelemetryClient {
  if (!config.telemetryEnabled || config.provider === 'noop') {
    return new NoopTelemetryClient();
  }

  switch (config.provider) {
    case 'posthog': {
      const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
      const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
      if (!apiKey) {
        return new ApiTelemetryClient();
      }
      return new PosthogTelemetryClient(apiKey, host);
    }
    case 'http':
    default:
      return new ApiTelemetryClient();
  }
}

let sharedClient: TelemetryClient | null = null;
let identifiedInstanceId: string | null = null;
const noopClient = new NoopTelemetryClient();

/** @internal test-only */
export function _resetTelemetryClient(): void {
  sharedClient = null;
  identifiedInstanceId = null;
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

  const [client, setClient] = useState<TelemetryClient>(sharedClient ?? noopClient);

  useEffect(() => {
    if (sharedClient) {
      setClient(sharedClient);
      return;
    }

    if (isError) {
      sharedClient = new ApiTelemetryClient();
      setClient(sharedClient);
      return;
    }

    if (config) {
      sharedClient = createClient(config);
      if (config.instanceId && identifiedInstanceId !== config.instanceId) {
        sharedClient.identify(config.instanceId, { provider: config.provider });
        identifiedInstanceId = config.instanceId;
      }
      setClient(sharedClient);
    }
  }, [config, isError]);

  return { client, ready: isSuccess || isError };
}
