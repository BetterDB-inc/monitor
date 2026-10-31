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
  /**
   * Optional pinned SSH server host-key fingerprint. When set, the connection
   * is rejected unless the server presents a key whose SHA256 fingerprint
   * matches. Accepts a `SHA256:<base64>` string or the raw base64/hex digest.
   */
  hostKeyFingerprint?: string;
  /**
   * Whether the secret fields above are currently encrypted at rest.
   * Server-managed only — never accepted from API input (see `SshTunnelInput`).
   */
  secretsEncrypted?: boolean;
}

/**
 * SSH tunnel shape accepted from API requests. Excludes `secretsEncrypted`,
 * which is set server-side after encryption; a client must never be able to
 * assert that plaintext secrets are already encrypted.
 */
export type SshTunnelInput = Omit<SshTunnelConfig, 'secretsEncrypted'>;

/**
 * How the monitor authenticates to the database.
 * - `password` (default): AUTH with the connection's username/password.
 * - `certificate`: no AUTH is sent; the server derives the ACL user from the
 *   client certificate (Valkey `tls-auth-clients-user`). Requires `tls` and a
 *   client certificate + key in `tlsConfig`.
 */
export type DatabaseAuthMode = 'password' | 'certificate';

/**
 * Where TLS certificate material comes from:
 * - `inline`: PEM content is supplied by the user and stored with the connection
 *   (the private key and passphrase encrypted when ENCRYPTION_KEY is set).
 * - `file`: the files live on the server's filesystem. Paths must resolve inside
 *   the directory named by `BETTERDB_TLS_CERT_DIR`; disabled when unset.
 */
export type TlsMaterialSource = 'inline' | 'file';

/**
 * Optional TLS material for a direct connection, used only when `tls` is on:
 * a CA bundle to verify a server issued by a private PKI, and a client
 * certificate + private key presented to the server (mutual TLS).
 *
 * Secret fields (`key`, `passphrase`) are envelope-encrypted at rest when
 * ENCRYPTION_KEY is configured; `secretsEncrypted` records whether the persisted
 * values are ciphertext. `ca`, `cert` and the `*Path` fields are not secrets.
 */
export interface TlsConfig {
  /** Where `ca`/`cert`/`key` come from. Defaults to `inline`. */
  source?: TlsMaterialSource;
  /** CA bundle (PEM) used to verify the server certificate (`source === 'inline'`). */
  ca?: string;
  /** Server-side path to the CA bundle (`source === 'file'`). */
  caPath?: string;
  /** Client certificate (PEM) presented to the server (`source === 'inline'`). */
  cert?: string;
  /** Server-side path to the client certificate (`source === 'file'`). */
  certPath?: string;
  /** Client private key (PEM) matching `cert` (`source === 'inline'`, secret). */
  key?: string;
  /** Server-side path to the client private key (`source === 'file'`). */
  keyPath?: string;
  /** Optional passphrase protecting the private key (secret). */
  passphrase?: string;
  /**
   * Whether the secret fields above are currently encrypted at rest.
   * Server-managed only — never accepted from API input (see `TlsConfigInput`).
   */
  secretsEncrypted?: boolean;
  /**
   * Server-managed only: the `*Path` fields are operator-supplied absolute paths
   * (DB_TLS_*_FILE on the env-configured connection) and are read as-is instead
   * of inside BETTERDB_TLS_CERT_DIR. Never accepted from API input.
   */
  trustedPaths?: boolean;
}

/** TLS material shape accepted from API requests (see `SshTunnelInput`). */
export type TlsConfigInput = Omit<TlsConfig, 'secretsEncrypted' | 'trustedPaths'>;

/** Redacted TLS material summary safe to return over the API (no PEM content). */
export interface TlsConfigStatus {
  source: TlsMaterialSource;
  /** Whether a custom CA bundle is configured. */
  hasCa: boolean;
  /** Whether a client certificate + key is configured (mutual TLS). */
  hasClientCert: boolean;
}

/** True when the config carries a client certificate and key (from either source). */
export function hasClientCertificate(config: TlsConfig | undefined): boolean {
  if (!config) return false;
  return config.source === 'file' ? !!config.certPath && !!config.keyPath : !!config.cert && !!config.key;
}

/** True when the config carries a CA bundle (from either source). */
export function hasCaBundle(config: TlsConfig | undefined): boolean {
  if (!config) return false;
  return config.source === 'file' ? !!config.caPath : !!config.ca;
}

export function tlsConfigStatus(config: TlsConfig | undefined): TlsConfigStatus | undefined {
  if (!config) return undefined;
  return {
    source: config.source === 'file' ? 'file' : 'inline',
    hasCa: hasCaBundle(config),
    hasClientCert: hasClientCertificate(config),
  };
}

export type DatabaseConnectionType = 'direct' | 'external';

export type TopologyKind = 'cluster' | 'sentinel';

export type TopologyRole = 'primary' | 'replica';

export type TopologyMembershipOrigin = 'auto' | 'adopted';

export interface TopologyMembership {
  seedId: string;
  nodeId: string;
  origin: TopologyMembershipOrigin;
  source: TopologyKind;
  group?: string;
  role?: TopologyRole;
  hostname?: string;
  retiredAt?: number;
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
  /** Username for data nodes discovered through this Sentinel; defaults to username */
  nodeUsername?: string;
  /** Password for data nodes discovered through this Sentinel; defaults to password (secret) */
  nodePassword?: string;
  /** Whether nodePassword is encrypted (envelope encryption) */
  nodePasswordEncrypted?: boolean;
  dbIndex?: number;
  tls?: boolean;
  /** TLS material (custom CA, client certificate) used when `tls` is on. */
  tlsConfig?: TlsConfig;
  /** How the monitor authenticates; defaults to `password`. */
  authMode?: DatabaseAuthMode;
  /** Optional SSH tunnel used to reach the database. */
  sshTunnel?: SshTunnelConfig;
  isDefault?: boolean;
  createdAt: number;
  updatedAt?: number;
  connectionType?: DatabaseConnectionType;
  autoRegisterNodes?: boolean;
  membership?: TopologyMembership;
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
  return parseJsonColumn<SshTunnelConfig>(value);
}

/**
 * Parse a persisted JSON column value (a JSON string or an already-parsed
 * object) into `T`, or `undefined` when absent, blank or invalid. Shared by the
 * SQL storage adapters so every JSON column deserialises the same way.
 */
export function parseJsonColumn<T extends object>(value: unknown): T | undefined {
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
  return obj as T;
}

/**
 * Parse a persisted TLS config value (JSON string or already-parsed object) into
 * a `TlsConfig`, or `undefined` when absent/invalid.
 */
export function parseTlsConfig(value: unknown): TlsConfig | undefined {
  return parseJsonColumn<TlsConfig>(value);
}

export function hasOwnKeyAnalytics(membership: TopologyMembership | undefined): boolean {
  if (!membership) {
    return true;
  }
  return membership.source === 'sentinel' && membership.role === 'primary' && membership.retiredAt === undefined;
}

export function parseMembership(value: unknown): TopologyMembership | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let obj: unknown = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const m = obj as Record<string, unknown>;
  if (typeof m.seedId !== 'string' || typeof m.nodeId !== 'string') return undefined;
  if (m.origin !== 'auto' && m.origin !== 'adopted') return undefined;
  const source = m.source ?? 'cluster';
  if (source !== 'cluster' && source !== 'sentinel') return undefined;
  return {
    seedId: m.seedId,
    nodeId: m.nodeId,
    origin: m.origin,
    source,
    ...(typeof m.group === 'string' ? { group: m.group } : {}),
    ...(m.role === 'primary' || m.role === 'replica' ? { role: m.role } : {}),
    ...(typeof m.hostname === 'string' && m.hostname !== '' ? { hostname: m.hostname } : {}),
    ...(typeof m.retiredAt === 'number' ? { retiredAt: m.retiredAt } : {}),
  };
}

/**
 * Connection capabilities
 */
export interface ConnectionCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  supportsCommandLog?: boolean;
  supportsSlotStats?: boolean;
  clusterEnabled?: boolean;
  isSentinel?: boolean;
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
  /** Whether a host-key fingerprint is pinned for this tunnel. */
  hostKeyPinned?: boolean;
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
  /** Redacted TLS material summary (present when a CA or client certificate is configured). */
  tlsConfig?: TlsConfigStatus;
  /** How the monitor authenticates; absent means `password`. */
  authMode?: DatabaseAuthMode;
  /**
   * ACL user the server reports for the live connection (`ACL WHOAMI`), so a
   * certificate-mapped identity can be confirmed. Absent when disconnected or
   * when the server does not support ACL.
   */
  authenticatedUser?: string;
  /** Redacted SSH tunnel summary (present when the connection uses a tunnel). */
  sshTunnel?: SshTunnelStatus;
  isDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
  isConnected: boolean;
  connectionType?: 'direct' | 'agent' | 'external';
  autoRegisterNodes?: boolean;
  membership?: TopologyMembership;
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
  nodeUsername?: string;
  nodePassword?: string;
  dbIndex?: number;
  tls?: boolean;
  /** TLS material (custom CA, client certificate) used when `tls` is on. */
  tlsConfig?: TlsConfigInput;
  /** How the monitor authenticates; defaults to `password`. */
  authMode?: DatabaseAuthMode;
  /** Optional SSH tunnel used to reach the database. */
  sshTunnel?: SshTunnelInput;
  setAsDefault?: boolean;
  connectionType?: DatabaseConnectionType;
  /** Address the OTLP collector pushes under when it differs from host:port (external only). */
  discoveredHost?: string;
  discoveredPort?: number;
}

/**
 * Response from testing a connection
 */
export interface TestConnectionResponse {
  success: boolean;
  capabilities?: ConnectionCapabilities;
  /** ACL user the server reported for the test connection (`ACL WHOAMI`), when available. */
  authenticatedUser?: string;
  error?: string;
  message?: string;
}

/**
 * Response for listing all connections
 */
export interface ConnectionListResponse {
  connections: ConnectionStatus[];
  currentId: string | null;
  autoRegisterNodesDefault: boolean;
  autoRegisterSentinelNodesDefault: boolean;
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

export interface DiscoveredInstance {
  host: string;
  port: number;
  suggestedName: string;
  dbSystem?: 'redis' | 'valkey';
  version?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  droppedPoints: number;
}

export interface DiscoveredInstancesResponse {
  enabled: boolean;
  instances: DiscoveredInstance[];
}
