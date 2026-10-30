import { readFileSync } from 'fs';
import type { DatabaseAuthMode, TlsConfig } from '@betterdb/shared';
import { isTrueFlag } from './env-normalize';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: 'valkey' | 'redis' | 'auto';
  tls: boolean;
  /** Custom CA / client certificate for the env-configured connection (DB_TLS_*_FILE). */
  tlsConfig?: TlsConfig;
  /** DB_AUTH_MODE: `password` (default) or `certificate` (no AUTH; identity from the client cert). */
  authMode?: DatabaseAuthMode;
}

/**
 * Read a PEM file named by an env var into inline material. The operator owns
 * the environment, so these paths are trusted as-is (no allowlist directory);
 * an unreadable file fails startup loudly rather than silently connecting
 * without the certificate.
 */
function readPemFromEnv(name: string): string | undefined {
  const filePath = process.env[name]?.trim();
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${name}: cannot read ${filePath}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

function envTlsConfig(): TlsConfig | undefined {
  // The files are TLS material; a non-TLS deployment must not fail to start
  // because a stale DB_TLS_*_FILE path is still set in its environment.
  if (!isTrueFlag(process.env.DB_TLS)) return undefined;
  const ca = readPemFromEnv('DB_TLS_CA_FILE');
  const cert = readPemFromEnv('DB_TLS_CERT_FILE');
  const key = readPemFromEnv('DB_TLS_KEY_FILE');
  const passphrase = process.env.DB_TLS_KEY_PASSPHRASE || undefined;
  if (!ca && !cert && !key) return undefined;
  return { source: 'inline', ca, cert, key, passphrase };
}

function envAuthMode(): DatabaseAuthMode | undefined {
  const raw = process.env.DB_AUTH_MODE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'password' || raw === 'certificate') return raw;
  throw new Error(`DB_AUTH_MODE must be 'password' or 'certificate' (got '${raw}')`);
}

export interface StorageConfig {
  type: 'sqlite';
  sqlite: {
    filepath: string;
  };
  audit: {
    pollIntervalMs: number;
  };
  clientAnalytics: {
    pollIntervalMs: number;
  };
}

export interface AiConfig {
  enabled: boolean;
  ollamaUrl: string;
  ollamaKeepAlive: string;
  useLlmClassification: boolean;
  lancedbPath: string;
  valkeyDocsPath: string;
}

export interface AnomalyConfig {
  enabled: boolean;
  pollIntervalMs: number;
  cacheTtlMs: number;
  prometheusSummaryIntervalMs: number;
}

export interface AppConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
  ai: AiConfig;
  anomaly: AnomalyConfig;
}

export default (): AppConfig => ({
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '6379', 10),
    username: process.env.DB_USERNAME || 'default',
    password: process.env.DB_PASSWORD || '',
    type: (process.env.DB_TYPE as 'valkey' | 'redis' | 'auto') || 'auto',
    // Enable TLS for the env-configured default connection (e.g. Aiven,
    // ElastiCache Serverless, or any managed provider that requires
    // encryption). UI-added connections carry their own per-connection tls flag.
    // isTrueFlag trims whitespace so a trailing newline from a secret store does
    // not silently disable TLS.
    tls: isTrueFlag(process.env.DB_TLS),
    // Custom CA (private PKI) and client certificate (mutual TLS) for the env
    // connection, read from files so Kubernetes/Docker secrets mount directly.
    tlsConfig: envTlsConfig(),
    authMode: envAuthMode(),
  },
  storage: {
    type: 'sqlite',
    sqlite: {
      filepath: process.env.STORAGE_SQLITE_FILEPATH || './data/audit.db',
    },
    audit: {
      pollIntervalMs: parseInt(process.env.AUDIT_POLL_INTERVAL_MS || '60000', 10),
    },
    clientAnalytics: {
      pollIntervalMs: parseInt(process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS || '60000', 10),
    },
  },
  ai: {
    enabled: process.env.AI_ENABLED === 'true',
    ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || '24h',
    useLlmClassification: process.env.AI_USE_LLM_CLASSIFICATION === 'true',
    lancedbPath: process.env.LANCEDB_PATH || './data/lancedb',
    valkeyDocsPath: process.env.VALKEY_DOCS_PATH || './data/valkey-docs',
  },
  anomaly: {
    enabled: process.env.ANOMALY_DETECTION_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.ANOMALY_POLL_INTERVAL_MS || '1000', 10),
    cacheTtlMs: parseInt(process.env.ANOMALY_CACHE_TTL_MS || '3600000', 10),
    prometheusSummaryIntervalMs: parseInt(process.env.ANOMALY_PROMETHEUS_INTERVAL_MS || '30000', 10),
  },
});
