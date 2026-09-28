import { envSchema, validateEnv } from '../env.schema';

describe('envSchema', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('default values', () => {
    it('should provide defaults for all required fields', () => {
      const result = envSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(3001);
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.DB_HOST).toBe('localhost');
        expect(result.data.DB_PORT).toBe(6379);
        expect(result.data.DB_TYPE).toBe('auto');
        expect(result.data.STORAGE_TYPE).toBe('sqlite');
      }
    });
  });

  describe('PORT validation', () => {
    it('should accept valid port numbers', () => {
      const result = envSchema.safeParse({ PORT: '8080' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
      }
    });

    it('should reject port 0', () => {
      const result = envSchema.safeParse({ PORT: '0' });
      expect(result.success).toBe(false);
    });

    it('should reject ports above 65535', () => {
      const result = envSchema.safeParse({ PORT: '65536' });
      expect(result.success).toBe(false);
    });

    it('should reject non-numeric ports', () => {
      const result = envSchema.safeParse({ PORT: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('NODE_ENV validation', () => {
    it('should accept development', () => {
      const result = envSchema.safeParse({ NODE_ENV: 'development' });
      expect(result.success).toBe(true);
    });

    it('should accept production', () => {
      const result = envSchema.safeParse({ NODE_ENV: 'production' });
      expect(result.success).toBe(true);
    });

    it('should accept test', () => {
      const result = envSchema.safeParse({ NODE_ENV: 'test' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid environments', () => {
      const result = envSchema.safeParse({ NODE_ENV: 'staging' });
      expect(result.success).toBe(false);
    });
  });

  describe('DB_TYPE validation', () => {
    it('should accept valkey', () => {
      const result = envSchema.safeParse({ DB_TYPE: 'valkey' });
      expect(result.success).toBe(true);
    });

    it('should accept redis', () => {
      const result = envSchema.safeParse({ DB_TYPE: 'redis' });
      expect(result.success).toBe(true);
    });

    it('should accept auto', () => {
      const result = envSchema.safeParse({ DB_TYPE: 'auto' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid types', () => {
      const result = envSchema.safeParse({ DB_TYPE: 'mysql' });
      expect(result.success).toBe(false);
    });
  });

  describe('STORAGE_TYPE validation', () => {
    it('should accept sqlite', () => {
      const result = envSchema.safeParse({ STORAGE_TYPE: 'sqlite' });
      expect(result.success).toBe(true);
    });

    it('should accept postgres', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'postgres',
        STORAGE_URL: 'postgres://localhost:5432/db',
      });
      expect(result.success).toBe(true);
    });

    it('should accept postgresql', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'postgresql',
        STORAGE_URL: 'postgresql://localhost:5432/db',
      });
      expect(result.success).toBe(true);
    });

    it('should accept memory', () => {
      const result = envSchema.safeParse({ STORAGE_TYPE: 'memory' });
      expect(result.success).toBe(true);
    });

    it('should require STORAGE_URL when STORAGE_TYPE is postgres', () => {
      const result = envSchema.safeParse({ STORAGE_TYPE: 'postgres' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('STORAGE_URL');
      }
    });

    it('should require STORAGE_URL when STORAGE_TYPE is postgresql', () => {
      const result = envSchema.safeParse({ STORAGE_TYPE: 'postgresql' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('STORAGE_URL');
      }
    });

    it('should reject invalid STORAGE_URL for postgres', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'postgres',
        STORAGE_URL: 'mysql://localhost:3306/db',
      });
      expect(result.success).toBe(false);
    });

    it('should require STORAGE_AUTH_TOKEN for a libsql:// STORAGE_URL', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'turso',
        STORAGE_URL: 'libsql://db.turso.io',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('STORAGE_AUTH_TOKEN');
      }
    });

    it('should accept an https:// STORAGE_URL with a token', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'turso',
        STORAGE_URL: 'https://db.turso.io',
        STORAGE_AUTH_TOKEN: 'token',
      });
      expect(result.success).toBe(true);
    });

    it('should accept an http:// STORAGE_URL with no token', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'turso',
        STORAGE_URL: 'http://localhost:8080',
      });
      expect(result.success).toBe(true);
    });

    it('should reject a token on an http:// STORAGE_URL', () => {
      const result = envSchema.safeParse({
        STORAGE_TYPE: 'turso',
        STORAGE_URL: 'http://localhost:8080',
        STORAGE_AUTH_TOKEN: 'token',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('cleartext');
      }
    });
  });

  describe('polling interval validation', () => {
    it('should accept valid polling intervals', () => {
      const result = envSchema.safeParse({
        AUDIT_POLL_INTERVAL_MS: '5000',
        CLIENT_ANALYTICS_POLL_INTERVAL_MS: '10000',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.AUDIT_POLL_INTERVAL_MS).toBe(5000);
        expect(result.data.CLIENT_ANALYTICS_POLL_INTERVAL_MS).toBe(10000);
      }
    });

    it('should reject polling intervals below 1000ms', () => {
      const result = envSchema.safeParse({ AUDIT_POLL_INTERVAL_MS: '500' });
      expect(result.success).toBe(false);
    });

    it('should default AI_OBS_POLL_INTERVAL_MS to 15000 and reject sub-1000ms', () => {
      const ok = envSchema.safeParse({});
      expect(ok.success && ok.data.AI_OBS_POLL_INTERVAL_MS).toBe(15000);
      expect(envSchema.safeParse({ AI_OBS_POLL_INTERVAL_MS: '500' }).success).toBe(false);
    });
  });

  describe('ACTIVITY_RETENTION_DAYS validation', () => {
    it('should accept a whole number of days', () => {
      const result = envSchema.safeParse({ ACTIVITY_RETENTION_DAYS: '100' });
      expect(result.success).toBe(true);
    });

    it('should treat a missing or blank value as unset', () => {
      expect(envSchema.safeParse({}).success).toBe(true);
      expect(envSchema.safeParse({ ACTIVITY_RETENTION_DAYS: '' }).success).toBe(true);
      expect(envSchema.safeParse({ ACTIVITY_RETENTION_DAYS: '   ' }).success).toBe(true);
    });

    it.each(['1e2', '1.5', '0', '-5', '30days', '9007199254740993'])(
      'should reject %s',
      (value) => {
        expect(envSchema.safeParse({ ACTIVITY_RETENTION_DAYS: value }).success).toBe(false);
      },
    );
  });

  describe('boolean transforms', () => {
    it('should transform AI_ENABLED to true when "true"', () => {
      const result = envSchema.safeParse({ AI_ENABLED: 'true' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.AI_ENABLED).toBe(true);
      }
    });

    it('should transform AI_ENABLED to false for other values', () => {
      const result = envSchema.safeParse({ AI_ENABLED: 'false' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.AI_ENABLED).toBe(false);
      }
    });

    it('should transform ANOMALY_DETECTION_ENABLED to false only when "false"', () => {
      const result = envSchema.safeParse({ ANOMALY_DETECTION_ENABLED: 'false' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ANOMALY_DETECTION_ENABLED).toBe(false);
      }
    });

    it('should transform ANOMALY_DETECTION_ENABLED to true for other values', () => {
      const result = envSchema.safeParse({ ANOMALY_DETECTION_ENABLED: 'yes' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ANOMALY_DETECTION_ENABLED).toBe(true);
      }
    });

    it('reads BETTERDB_TELEMETRY through the shared negative set, trimming like CLOUD_MODE', () => {
      // Parity guard for the isNegativeEnvValue helper CLOUD_MODE also uses: a
      // padded ' off ' opts out here exactly as ' off ' reads self-hosted for
      // CLOUD_MODE, and every accepted negative spelling disables telemetry.
      for (const off of ['false', '0', 'no', 'off', 'OFF', ' off ', '\tno\n']) {
        const result = envSchema.safeParse({ BETTERDB_TELEMETRY: off });
        expect(result.success && result.data.BETTERDB_TELEMETRY).toBe(false);
      }
      for (const on of ['true', '1', 'yes', 'anything']) {
        const result = envSchema.safeParse({ BETTERDB_TELEMETRY: on });
        expect(result.success && result.data.BETTERDB_TELEMETRY).toBe(true);
      }
    });
  });

  describe('URL validation', () => {
    it('should accept valid OLLAMA_BASE_URL', () => {
      const result = envSchema.safeParse({ OLLAMA_BASE_URL: 'http://ollama:11434' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid OLLAMA_BASE_URL', () => {
      const result = envSchema.safeParse({ OLLAMA_BASE_URL: 'not-a-url' });
      expect(result.success).toBe(false);
    });
  });

  describe('OTLP ingest token in cloud mode', () => {
    it('requires OTEL_INGEST_TOKEN when CLOUD_MODE is set', () => {
      const result = envSchema.safeParse({ CLOUD_MODE: 'true', PROMETHEUS_METRICS_TOKEN: 'token' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('OTEL_INGEST_TOKEN'))).toBe(true);
      }
    });

    it('accepts CLOUD_MODE when both OTEL_INGEST_TOKEN and PROMETHEUS_METRICS_TOKEN are provided', () => {
      const result = envSchema.safeParse({
        CLOUD_MODE: 'true',
        OTEL_INGEST_TOKEN: 'secret',
        PROMETHEUS_METRICS_TOKEN: 'token',
      });
      expect(result.success).toBe(true);
    });

    it('does not require the token when not in cloud mode', () => {
      const result = envSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('treats CLOUD_MODE=false as self-hosted (token not required)', () => {
      const result = envSchema.safeParse({ CLOUD_MODE: 'false' });
      expect(result.success).toBe(true);
    });

    it('requires the token for ANY truthy CLOUD_MODE value, not just "true"', () => {
      // Regression guard: the boot check and the runtime ingest guard must
      // share isCloudModeValue semantics — CLOUD_MODE=1 once passed boot
      // validation and then 401ed every /v1/traces request at runtime.
      for (const value of ['1', 'yes', 'TRUE']) {
        const result = envSchema.safeParse({
          CLOUD_MODE: value,
          PROMETHEUS_METRICS_TOKEN: 'token',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.path.includes('OTEL_INGEST_TOKEN'))).toBe(true);
        }
      }
      for (const negative of ['0', 'no', 'off', 'False']) {
        expect(envSchema.safeParse({ CLOUD_MODE: negative }).success).toBe(true);
      }
    });

    it('defaults OTEL_INGEST_ENABLED to true', () => {
      const result = envSchema.safeParse({});
      expect(result.success && result.data.OTEL_INGEST_ENABLED).toBe(true);
    });

    it.each(['false', '0', ' FALSE ', '0\n'])('parses OTEL_INGEST_ENABLED=%j as disabled', (value) => {
      const result = envSchema.safeParse({ OTEL_INGEST_ENABLED: value });
      expect(result.success && result.data.OTEL_INGEST_ENABLED).toBe(false);
    });
  });

  describe('Prometheus poll interval validation', () => {
    it('should coerce a numeric poll interval', () => {
      const result = envSchema.safeParse({ PROMETHEUS_POLL_INTERVAL_MS: '2000' });
      expect(result.success && result.data.PROMETHEUS_POLL_INTERVAL_MS).toBe(2000);
    });

    it('should leave the poll interval unset when it is absent', () => {
      const result = envSchema.safeParse({});
      expect(result.success && result.data.PROMETHEUS_POLL_INTERVAL_MS).toBeUndefined();
    });

    it('should reject a poll interval below one second', () => {
      const result = envSchema.safeParse({ PROMETHEUS_POLL_INTERVAL_MS: '999' });
      expect(result.success).toBe(false);
    });

    it('should reject a non-numeric poll interval', () => {
      const result = envSchema.safeParse({ PROMETHEUS_POLL_INTERVAL_MS: 'soon' });
      expect(result.success).toBe(false);
    });
  });

  describe('validateEnv function', () => {
    it('should exit with error for invalid config', () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      process.env = { PORT: '-1' };
      validateEnv();

      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });
});
