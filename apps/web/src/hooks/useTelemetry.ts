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

async function loadTelemetryClient(): Promise<TelemetryClient> {
  try {
    const config = await fetchApi<TelemetryConfig>('/telemetry/config');
    const client = createClient(config);
    if (config.instanceId) {
      client.identify(config.instanceId, { provider: config.provider });
    }
    return client;
  } catch {
    return new ApiTelemetryClient();
  }
}

const clientPromise = loadTelemetryClient();

export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>({
    client: new NoopTelemetryClient(),
    ready: false,
  });

  useEffect(() => {
    clientPromise.then((client) => {
      setState({ client, ready: true });
    });
  }, []);

  return state;
}
