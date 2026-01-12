export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: 'valkey' | 'redis' | 'auto';
}

export interface StorageConfig {
  type: 'sqlite';
  sqlite: {
    filepath: string;
  };
  audit: {
    enabled: boolean;
    pollIntervalMs: number;
    retentionDays: number;
  };
  clientAnalytics: {
    enabled: boolean;
    pollIntervalMs: number;
    retentionDays: number;
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

export interface AppConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
  ai: AiConfig;
}

export default (): AppConfig => ({
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '6379', 10),
    username: process.env.DB_USERNAME || 'default',
    password: process.env.DB_PASSWORD || '',
    type: (process.env.DB_TYPE as 'valkey' | 'redis' | 'auto') || 'auto',
  },
  storage: {
    type: 'sqlite',
    sqlite: {
      filepath: process.env.STORAGE_SQLITE_PATH || './data/audit.db',
    },
    audit: {
      enabled: process.env.AUDIT_ENABLED === 'true' || true,
      pollIntervalMs: parseInt(process.env.AUDIT_POLL_INTERVAL_MS || '60000', 10),
      retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '30', 10),
    },
    clientAnalytics: {
      enabled: process.env.CLIENT_ANALYTICS_ENABLED === 'true' || true,
      pollIntervalMs: parseInt(process.env.CLIENT_ANALYTICS_POLL_INTERVAL_MS || '60000', 10),
      retentionDays: parseInt(process.env.CLIENT_ANALYTICS_RETENTION_DAYS || '7', 10),
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
});
