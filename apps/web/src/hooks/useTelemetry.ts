import { useState, useEffect } from 'react';
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

let cachedClient: TelemetryClient | null = null;
let configPromise: Promise<TelemetryClient> | null = null;

function loadTelemetryClient(): Promise<TelemetryClient> {
  if (!configPromise) {
    configPromise = fetchApi<TelemetryConfig>('/telemetry/config')
      .then((config) => {
        const client = createClient(config);
        if (config.instanceId) {
          client.identify(config.instanceId, { provider: config.provider });
        }
        cachedClient = client;
        return client;
      })
      .catch(() => {
        cachedClient = new ApiTelemetryClient();
        return cachedClient;
      });
  }
  return configPromise;
}

export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>({
    client: cachedClient ?? new NoopTelemetryClient(),
    ready: cachedClient !== null,
  });

  useEffect(() => {
    if (cachedClient) {
      setState({ client: cachedClient, ready: true });
      return;
    }

    loadTelemetryClient().then((client) => {
      setState({ client, ready: true });
    });
  }, []);

  return state;
}
