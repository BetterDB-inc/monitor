export interface DatabaseCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  hasCommandLog: boolean;
  hasSlotStats: boolean;
  hasClusterSlotStats: boolean;
  hasLatencyMonitor: boolean;
  hasAclLog: boolean;
  hasMemoryDoctor: boolean;
}

export interface HealthResponse {
  status: 'connected' | 'disconnected' | 'error';
  database: {
    type: 'valkey' | 'redis' | 'unknown';
    version: string | null;
    host: string;
    port: number;
  };
  capabilities: DatabaseCapabilities | null;
  error?: string;
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
