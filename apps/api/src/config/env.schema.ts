import { z } from 'zod';

/**
 * Environment variable validation schema
 * Validates all environment variables at application startup
 */
export const envSchema = z
  .object({
    // Application
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Database (Valkey/Redis connection)
    DB_HOST: z.string().min(1).default('localhost'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    DB_USERNAME: z.string().default('default'),
    DB_PASSWORD: z.string().default(''),
    DB_TYPE: z.enum(['valkey', 'redis', 'auto']).default('auto'),

    // Storage configuration
    STORAGE_TYPE: z.enum(['sqlite', 'postgres', 'postgresql', 'memory']).default('sqlite'),
    STORAGE_URL: z.string().url().optional(),
    STORAGE_SQLITE_FILEPATH: z.string().default('./data/audit.db'),
    DB_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .max(63)
      .optional(),

    // CLI static directory override
    BETTERDB_STATIC_DIR: z.string().optional(),

    // Polling intervals
    AUDIT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
    CLIENT_ANALYTICS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
    AI_OBS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),

    // AI configuration
    AI_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
    OLLAMA_KEEP_ALIVE: z.string().default('24h'),
    AI_USE_LLM_CLASSIFICATION: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    LANCEDB_PATH: z.string().default('./data/lancedb'),
    VALKEY_DOCS_PATH: z.string().default('./data/valkey-docs'),

    // Anomaly detection
    ANOMALY_DETECTION_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    ANOMALY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    ANOMALY_CACHE_TTL_MS: z.coerce.number().int().min(1000).default(3600000),
    ANOMALY_PROMETHEUS_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),

    // License configuration (optional)
    BETTERDB_LICENSE_KEY: z.string().optional(),
    // Offline (air-gapped) license: the signed token itself, or a path to it
    BETTERDB_OFFLINE_LICENSE: z.string().optional(),
    BETTERDB_OFFLINE_LICENSE_FILE: z.string().optional(),
    // Accept unsigned entitlement responses from legacy servers (insecure)
    LICENSE_ALLOW_UNSIGNED: z.string().optional(),
    // Directory for persisted licensing state — mount a volume here in
    // containers so the offline license / signed-token grace survive restarts
    BETTERDB_DATA_DIR: z.string().optional(),
    ENTITLEMENT_URL: z.string().url().optional(),
    LICENSE_CACHE_TTL_MS: z.coerce.number().int().min(60000).optional(),
    LICENSE_MAX_STALE_MS: z.coerce.number().int().min(60000).optional(),
    LICENSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).optional(),
    BETTERDB_TELEMETRY: z
      .string()
      .transform((v) => !['false', '0', 'no', 'off'].includes(v.toLowerCase()))
      .optional(),
    TELEMETRY_PROVIDER: z.enum(['http', 'posthog', 'noop']).default('posthog'),
    POSTHOG_API_KEY: z.string().optional(),
    POSTHOG_HOST: z.url().optional(),

    // CLI configuration
    BETTERDB_UNSAFE_CLI: z
      .string()
      .default('false')
      .transform((v) => v === 'true')
      .describe('Allow all CLI commands'),

    // Version check configuration
    VERSION_CHECK_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),

    // Webhook configuration
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).optional(),
    WEBHOOK_MAX_RESPONSE_BODY_BYTES: z.coerce.number().int().min(0).optional(),

    // Monitor health gate
    MONITOR_RECENT_OOM_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(5 * 60 * 1000),
    MONITOR_RECENT_FAILOVER_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(2 * 60 * 1000),
    MONITOR_MEMORY_PCT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(85),
    MONITOR_REPLICATION_LAG_BYTES: z.coerce
      .number()
      .int()
      .min(0)
      .default(10 * 1024 * 1024),
    MONITOR_PERSISTENCE_STALL_SEC: z.coerce.number().int().min(1).default(60),
    MONITOR_PERSISTENCE_WARN_SEC: z.coerce.number().int().min(1).default(120),
    MONITOR_PERSISTENCE_CRIT_SEC: z.coerce.number().int().min(1).default(600),

    // OTLP trace ingestion (AI observability Phase 2)
    OTEL_INGEST_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    OTEL_INGEST_TOKEN: z.string().optional(),

    // OTel telemetry export (mirror of Prometheus metrics). No-op unless
    // OTEL_EXPORTER_OTLP_ENDPOINT is set.
    OTEL_TELEMETRY_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().or(z.literal('')).optional(),
    OTEL_METRICS_EXPORT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),

    // Cloud mode (set by the hosted deployment; gates per-tenant auth)
    CLOUD_MODE: z.string().optional(),

    // Security
    ENCRYPTION_KEY: z.string().min(16).optional(),
  })
  .superRefine((data, ctx) => {
    // Require STORAGE_URL when using postgres
    if (
      (data.STORAGE_TYPE === 'postgres' || data.STORAGE_TYPE === 'postgresql') &&
      !data.STORAGE_URL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'STORAGE_URL is required when STORAGE_TYPE is postgres or postgresql',
        path: ['STORAGE_URL'],
      });
    }

    // Validate STORAGE_URL is a valid postgres URL when provided
    if (
      data.STORAGE_URL &&
      (data.STORAGE_TYPE === 'postgres' || data.STORAGE_TYPE === 'postgresql')
    ) {
      if (
        !data.STORAGE_URL.startsWith('postgres://') &&
        !data.STORAGE_URL.startsWith('postgresql://')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'STORAGE_URL must be a valid PostgreSQL connection string (postgres:// or postgresql://)',
          path: ['STORAGE_URL'],
        });
      }
    }

    if (
      data.AI_ENABLED &&
      data.OLLAMA_BASE_URL === 'http://localhost:11434' &&
      data.NODE_ENV === 'production'
    ) {
      console.warn(
        'Warning: AI is enabled in production with default Ollama URL (localhost:11434)',
      );
    }

    // In cloud mode the OTLP ingest path is allowlisted past session auth, so the
    // bearer token is the only credential guarding it. Require it rather than
    // leaving a tenant's span store open to anonymous writes.
    if (data.CLOUD_MODE === 'true' && !data.OTEL_INGEST_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'OTEL_INGEST_TOKEN is required when CLOUD_MODE is set (guards OTLP trace ingestion)',
        path: ['OTEL_INGEST_TOKEN'],
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates environment variables at application startup
 * Exits the process with detailed error messages if validation fails
 */
export function validateEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('\n❌ Environment validation failed:\n');

    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      console.error(`  • ${path}: ${issue.message}`);
    }

    console.error('\nPlease check your environment variables and try again.\n');
    process.exit(1);
  }

  return result.data;
}

/**
 * Type-safe environment variable access
 * Use after calling validateEnv() to get validated config
 */
export function getValidatedEnv(): EnvConfig {
  return envSchema.parse(process.env);
}
