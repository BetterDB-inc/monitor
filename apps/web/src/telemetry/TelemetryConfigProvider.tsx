import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchApi } from '../api/client';
import type { TelemetryClient } from './telemetry-client.interface';
import { ApiTelemetryClient } from './clients/api-telemetry-client';
import { NoopTelemetryClient } from './clients/noop-telemetry-client';

interface TelemetryConfig {
  instanceId: string;
  telemetryEnabled: boolean;
  provider: string;
}

const TelemetryContext = createContext<TelemetryClient>(new NoopTelemetryClient());

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

export function TelemetryConfigProvider({ children }: { children: ReactNode }): ReactNode {
  const [client, setClient] = useState<TelemetryClient>(new NoopTelemetryClient());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetchApi<TelemetryConfig>('/telemetry/config')
      .then((config) => {
        const newClient = createClient(config);
        if (config.instanceId) {
          newClient.identify(config.instanceId, { provider: config.provider });
        }
        setClient(newClient);
      })
      .catch(() => {
        setClient(new ApiTelemetryClient());
      })
      .finally(() => {
        setReady(true);
      });
  }, []);

  if (!ready) return null;

  return <TelemetryContext value={client}>{children}</TelemetryContext>;
}

export function useTelemetry(): TelemetryClient {
  return useContext(TelemetryContext);
}
