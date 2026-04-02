import { useContext } from 'react';
import { TelemetryContext } from '../telemetry/TelemetryConfigProvider';
import type { TelemetryClient } from '../telemetry/telemetry-client.interface';

export function useTelemetry(): TelemetryClient {
  return useContext(TelemetryContext);
}
