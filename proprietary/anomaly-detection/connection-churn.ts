export const CHURN_FLAT_POPULATION_RATIO = 0.1;
export const CHURN_MIN_CONNECTS_PER_SEC = 10;
export const CHURN_POPULATION_WINDOW_MS = 60_000;

export interface ConnectionChurnReading {
  totalReceived: number;
  connectedClients: number;
  timestamp: number;
}

export interface ConnectionChurnSample {
  timestamp: number;
  connectsPerSec: number | null;
  connectedClients: number;
  clientsDeltaRatio: number | null;
}

export function computeConnectionChurn(
  prev: ConnectionChurnReading | undefined,
  curr: ConnectionChurnReading,
  populationBaseline: number | undefined = prev?.connectedClients,
): ConnectionChurnSample {
  const sample: ConnectionChurnSample = {
    timestamp: curr.timestamp,
    connectsPerSec: null,
    connectedClients: curr.connectedClients,
    clientsDeltaRatio: null,
  };
  if (!prev) return sample;

  const dtSec = (curr.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0 || curr.totalReceived < prev.totalReceived) return sample;

  sample.connectsPerSec = (curr.totalReceived - prev.totalReceived) / dtSec;
  const baseline = populationBaseline ?? prev.connectedClients;
  sample.clientsDeltaRatio = Math.abs(curr.connectedClients - baseline) / Math.max(1, baseline);
  return sample;
}

export function trimPopulationWindow(
  readings: ConnectionChurnReading[],
  now: number,
): ConnectionChurnReading[] {
  return readings.filter((r) => r.timestamp >= now - CHURN_POPULATION_WINDOW_MS);
}

export function isChurnWithFlatPopulation(sample: ConnectionChurnSample): boolean {
  return (
    sample.connectsPerSec !== null &&
    sample.clientsDeltaRatio !== null &&
    sample.connectsPerSec >= CHURN_MIN_CONNECTS_PER_SEC &&
    sample.clientsDeltaRatio < CHURN_FLAT_POPULATION_RATIO
  );
}
