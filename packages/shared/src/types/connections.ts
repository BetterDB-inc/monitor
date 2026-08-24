/**
 * Credential status for connections
 */
export type CredentialStatus =
  | 'valid'           // Credentials work, connection successful
  | 'invalid'         // Connection failed due to authentication
  | 'decryption_failed' // Password could not be decrypted (wrong key or missing key)
  | 'unknown';        // Not yet validated

/**
 * SSH authentication method.
 */
export type SshAuthMethod = 'password' | 'privateKey';

/**
 * Where an SSH private key comes from:
 * - `inline`: the PEM key content is supplied by the user and stored (encrypted)
 *   in this project's storage (option A).
 * - `file`: the key lives on the server's filesystem and is referenced by path.
 *   The path must resolve inside the directory named by the `BETTERDB_SSH_KEY_DIR`
 *   environment variable (option B); disabled when that variable is unset.
 */
export type SshKeySource = 'inline' | 'file';

/**
 * SSH tunnel configuration for reaching a database through a bastion/jump host.
 * A single hop is supported (no multi-hop chaining).
 *
 * Secret fields (`password`, `privateKey`, `passphrase`) are envelope-encrypted
 * at rest when ENCRYPTION_KEY is configured; `secretsEncrypted` records whether
 * the persisted values are ciphertext. `privateKeyPath` is not a secret.
 */
export interface SshTunnelConfig {
  enabled: boolean;
  /** SSH server (bastion) host. */
  host: string;
  /** SSH server port (default 22). */
  port: number;
  /** SSH username. */
  username: string;
  authMethod: SshAuthMethod;
  /** Password for `password` auth (secret). */
  password?: string;
  /** For `privateKey` auth: where the key comes from. Defaults to `inline`. */
  keySource?: SshKeySource;
  /** Inline PEM private key content when `keySource === 'inline'` (secret). */
  privateKey?: string;
  /** Server-side path to the key when `keySource === 'file'` (option B). */
  privateKeyPath?: string;
  /** Optional passphrase protecting the private key (secret). */
  passphrase?: string;
  /** Whether the secret fields above are currently encrypted at rest. */
  secretsEncrypted?: boolean;
}

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
  /** Optional SSH tunnel used to reach the database. */
  sshTunnel?: SshTunnelConfig;
  isDefault?: boolean;
  createdAt: number;
  updatedAt?: number;
  /** Status of credential validation (not persisted, set at runtime) */
  credentialStatus?: CredentialStatus;
  /** Error message when credentials are invalid */
  credentialError?: string;
}

/**
 * Parse a persisted SSH tunnel value (JSON string or already-parsed object)
 * into an `SshTunnelConfig`, or `undefined` when absent/invalid. Shared by the
 * SQL storage adapters so serialization stays consistent.
 */
export function parseSshTunnel(value: unknown): SshTunnelConfig | undefined {
  if (value === null || value === undefined) return undefined;
  let obj: unknown = value;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    try {
      obj = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  return obj as SshTunnelConfig;
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
 * Redacted SSH tunnel summary safe to return over the API (no secrets).
 */
export interface SshTunnelStatus {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  keySource?: SshKeySource;
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
  /** Redacted SSH tunnel summary (present when the connection uses a tunnel). */
  sshTunnel?: SshTunnelStatus;
  isDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
  isConnected: boolean;
  connectionType?: 'direct' | 'agent';
  capabilities?: ConnectionCapabilities;
  runtimeCapabilities?: import('./health').RuntimeCapabilities;
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
  /** Optional SSH tunnel used to reach the database. */
  sshTunnel?: SshTunnelConfig;
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
