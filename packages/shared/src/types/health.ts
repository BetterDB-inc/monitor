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
