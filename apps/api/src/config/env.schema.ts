import { z } from 'zod';

/**
 * Environment variable validation schema
 * Validates all environment variables at application startup
 */
export const envSchema = z.object({
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
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63).optional(),

  // CLI static directory override
  BETTERDB_STATIC_DIR: z.string().optional(),

  // Polling intervals
  AUDIT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  CLIENT_ANALYTICS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),

  // AI configuration
  AI_ENABLED: z.string().default('false').transform(v => v === 'true'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_KEEP_ALIVE: z.string().default('24h'),
  AI_USE_LLM_CLASSIFICATION: z.string().default('false').transform(v => v === 'true'),
  LANCEDB_PATH: z.string().default('./data/lancedb'),
  VALKEY_DOCS_PATH: z.string().default('./data/valkey-docs'),

  // Anomaly detection
  ANOMALY_DETECTION_ENABLED: z.string().default('true').transform(v => v !== 'false'),
  ANOMALY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  ANOMALY_CACHE_TTL_MS: z.coerce.number().int().min(1000).default(3600000),
  ANOMALY_PROMETHEUS_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),

  // License configuration (optional)
  BETTERDB_LICENSE_KEY: z.string().optional(),
  ENTITLEMENT_URL: z.string().url().optional(),
  LICENSE_CACHE_TTL_MS: z.coerce.number().int().min(60000).optional(),
  LICENSE_MAX_STALE_MS: z.coerce.number().int().min(60000).optional(),
  LICENSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).optional(),
  BETTERDB_TELEMETRY: z.string().transform(v => v !== 'false').optional(),

  // Version check configuration
  VERSION_CHECK_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),

  // Webhook configuration
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).optional(),
  WEBHOOK_MAX_RESPONSE_BODY_BYTES: z.coerce.number().int().min(0).optional(),

  // Security
  ENCRYPTION_KEY: z.string().min(16).optional(),
}).superRefine((data, ctx) => {
  // Require STORAGE_URL when using postgres
  if ((data.STORAGE_TYPE === 'postgres' || data.STORAGE_TYPE === 'postgresql') && !data.STORAGE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'STORAGE_URL is required when STORAGE_TYPE is postgres or postgresql',
      path: ['STORAGE_URL'],
    });
  }

  // Validate STORAGE_URL is a valid postgres URL when provided
  if (data.STORAGE_URL && (data.STORAGE_TYPE === 'postgres' || data.STORAGE_TYPE === 'postgresql')) {
    if (!data.STORAGE_URL.startsWith('postgres://') && !data.STORAGE_URL.startsWith('postgresql://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'STORAGE_URL must be a valid PostgreSQL connection string (postgres:// or postgresql://)',
        path: ['STORAGE_URL'],
      });
    }
  }

  if (data.AI_ENABLED && data.OLLAMA_BASE_URL === 'http://localhost:11434' && data.NODE_ENV === 'production') {
    console.warn('Warning: AI is enabled in production with default Ollama URL (localhost:11434)');
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
