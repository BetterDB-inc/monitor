export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: 'valkey' | 'redis' | 'auto';
  tls: boolean;
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
    tls: process.env.DB_TLS === 'true',
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
