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
