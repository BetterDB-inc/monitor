import { AnomalyWarmupStatus } from './health';

export const ANOMALY_SERVICE = 'ANOMALY_SERVICE';

/**
 * Interface for anomaly detection service warmup status
 * Used for optional injection when proprietary module is available
 */
export interface IAnomalyService {
  getWarmupStatus(): AnomalyWarmupStatus;
}
