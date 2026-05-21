export interface DatabaseCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  hasCommandLog: boolean;
  hasSlotStats: boolean;
  hasClusterSlotStats: boolean;
  hasLatencyMonitor: boolean;
  hasAclLog: boolean;
  hasMemoryDoctor: boolean;
  hasConfig: boolean;
  hasVectorSearch: boolean;
}

export interface RuntimeCapabilities {
  canSlowLog: boolean;
  canClientList: boolean;
  canAclLog: boolean;
  canClusterInfo: boolean;
  canClusterSlotStats: boolean;
  canCommandLog: boolean;
  canLatency: boolean;
  canMemory: boolean;
}

/** Reason a runtime capability is disabled and when it was disabled (ms epoch). */
export interface RuntimeCapabilityDisabledInfo {
  reason: string;
  disabledAt: number;
}

/** Map of capability key → disabled-reason. Capabilities that are still
 *  available are omitted, so the absence of a key means "fine". */
export type RuntimeCapabilityReasons = Partial<
  Record<keyof RuntimeCapabilities, RuntimeCapabilityDisabledInfo>
>;

/**
 * Verdict returned by POST /connections/:id/capabilities/:capability/retry.
 * `available: 'unknown'` means the probe failed for a transient reason
 * (network blip, timeout, connection reset) — the prior capability state
 * is preserved and the operator should try again rather than treat it as
 * a definitive answer.
 */
export interface CapabilityRetryVerdict {
  available: boolean | 'unknown';
  reason?: string;
}

export interface HealthResponse {
  status: 'connected' | 'disconnected' | 'error' | 'waiting';
  database: {
    type: 'valkey' | 'redis' | 'unknown';
    version: string | null;
    host: string;
    port: number;
  };
  capabilities: DatabaseCapabilities | null;
  runtimeCapabilities?: RuntimeCapabilities | null;
  runtimeCapabilityReasons?: RuntimeCapabilityReasons;
  error?: string;
  message?: string;
}

export interface AnomalyWarmupStatus {
  isReady: boolean;
  buffersReady: number;
  buffersTotal: number;
  warmupProgress: number; // 0-100 percentage
}

export interface LicenseWarmupStatus {
  isValidated: boolean;
  tier: string;
}

export interface DetailedHealthResponse extends HealthResponse {
  uptime: number;
  timestamp: number;
  anomalyDetection?: AnomalyWarmupStatus;
  license?: LicenseWarmupStatus;
}
