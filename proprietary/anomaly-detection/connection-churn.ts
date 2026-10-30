export const CHURN_MAX_RETAINED_RATIO = 0.1;
export const CHURN_MIN_CONNECTS_PER_SEC = 10;

export interface ConnectionChurnReading {
  totalReceived: number;
  connectedClients: number;
  timestamp: number;
}

export interface ConnectionChurnSample {
  timestamp: number;
  connectsPerSec: number | null;
  connectedClients: number;
  retainedRatio: number | null;
}

export function computeConnectionChurn(
  prev: ConnectionChurnReading | undefined,
  curr: ConnectionChurnReading,
): ConnectionChurnSample {
  const sample: ConnectionChurnSample = {
    timestamp: curr.timestamp,
    connectsPerSec: null,
    connectedClients: curr.connectedClients,
    retainedRatio: null,
  };
  if (!prev) return sample;

  const dtSec = (curr.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0 || curr.totalReceived < prev.totalReceived) return sample;

  sample.connectsPerSec = (curr.totalReceived - prev.totalReceived) / dtSec;
  sample.retainedRatio =
    Math.max(0, curr.connectedClients - prev.connectedClients) /
    Math.max(1, curr.totalReceived - prev.totalReceived);
  return sample;
}

export function isChurnWithFlatPopulation(sample: ConnectionChurnSample): boolean {
  return (
    sample.connectsPerSec !== null &&
    sample.retainedRatio !== null &&
    sample.connectsPerSec >= CHURN_MIN_CONNECTS_PER_SEC &&
    sample.retainedRatio < CHURN_MAX_RETAINED_RATIO
  );
}
