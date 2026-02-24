/**
 * Credential status for connections
 */
export type CredentialStatus =
  | 'valid'           // Credentials work, connection successful
  | 'invalid'         // Connection failed due to authentication
  | 'decryption_failed' // Password could not be decrypted (wrong key or missing key)
  | 'unknown';        // Not yet validated

/**
 * Connection configuration for storing database connections
 */
export interface DatabaseConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Whether the password is encrypted (envelope encryption) */
  passwordEncrypted?: boolean;
  dbIndex?: number;
  tls?: boolean;
  isDefault?: boolean;
  createdAt: number;
  updatedAt?: number;
  /** Status of credential validation (not persisted, set at runtime) */
  credentialStatus?: CredentialStatus;
  /** Error message when credentials are invalid */
  credentialError?: string;
}

/**
 * Connection capabilities
 */
export interface ConnectionCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  supportsCommandLog?: boolean;
  supportsSlotStats?: boolean;
}

/**
 * Connection status returned by the registry
 */
export interface ConnectionStatus {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  dbIndex?: number;
  tls?: boolean;
  isDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
  isConnected: boolean;
  connectionType?: 'direct' | 'agent';
  capabilities?: ConnectionCapabilities;
  /** Status of credential validation */
  credentialStatus?: CredentialStatus;
  /** Error message when credentials are invalid */
  credentialError?: string;
}

/**
 * Request to create a new connection
 */
export interface CreateConnectionRequest {
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  dbIndex?: number;
  tls?: boolean;
  setAsDefault?: boolean;
}

/**
 * Response from testing a connection
 */
export interface TestConnectionResponse {
  success: boolean;
  capabilities?: ConnectionCapabilities;
  error?: string;
}

/**
 * Response for listing all connections
 */
export interface ConnectionListResponse {
  connections: ConnectionStatus[];
  currentId: string | null;
}

/**
 * Response for getting current connection info
 */
export interface CurrentConnectionResponse {
  id: string | null;
}

/**
 * Health response for all connections
 */
export interface AllConnectionsHealthResponse {
  overallStatus: 'healthy' | 'degraded' | 'unhealthy' | 'waiting';
  connections: Array<{
    connectionId: string;
    connectionName: string;
    status: 'connected' | 'disconnected' | 'error' | 'waiting';
    database: {
      type: string;
      version: string | null;
      host: string;
      port: number;
    };
    capabilities: unknown;
    error?: string;
    message?: string;
  }>;
  timestamp: number;
  message?: string;
}
