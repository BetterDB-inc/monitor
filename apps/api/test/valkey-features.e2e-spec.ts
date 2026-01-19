import { Test, TestingModule } from '@nestjs/testing';
import { UnifiedDatabaseAdapter } from '../src/database/adapters/unified.adapter';

describe('Valkey-Specific Features (E2E)', () => {
  let adapter: UnifiedDatabaseAdapter;

  // These tests are specific to Valkey and should only run against Valkey instances
  // Use TEST_DB_HOST and TEST_DB_PORT to override defaults
  // Default to Valkey on 6380 (from docker-compose.yml)
  const DB_CONFIG = {
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '6380', 10),
    username: process.env.TEST_DB_USERNAME || 'default',
    password: process.env.TEST_DB_PASSWORD || 'devpassword',
  };

  beforeAll(async () => {
    adapter = new UnifiedDatabaseAdapter(DB_CONFIG);
    await adapter.connect();

    const capabilities = adapter.getCapabilities();
    if (capabilities.dbType !== 'valkey') {
      throw new Error('These tests require a Valkey instance. Connected to: ' + capabilities.dbType);
    }
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.disconnect();
    }
  });

  describe('Capability Detection', () => {
    it('should detect Valkey database type', () => {
      const capabilities = adapter.getCapabilities();
      expect(capabilities.dbType).toBe('valkey');
    });

    it('should detect version-specific capabilities', () => {
      const capabilities = adapter.getCapabilities();
      const version = capabilities.version.split('.').map(v => parseInt(v, 10));
      const majorVersion = version[0] || 0;
      const minorVersion = version[1] || 0;

      expect(capabilities.hasSlotStats).toBe(majorVersion >= 8);
      expect(capabilities.hasCommandLog).toBe(majorVersion > 8 || (majorVersion === 8 && minorVersion >= 1));
      expect(capabilities.hasClusterSlotStats).toBe(majorVersion >= 8);
    });
  });

  describe('COMMANDLOG (Valkey 8.1+)', () => {
    it('should retrieve COMMANDLOG if supported', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasCommandLog) {
        const commandLog = await adapter.getCommandLog(10);
        expect(Array.isArray(commandLog)).toBe(true);
      } else {
        // Skip test if Valkey version doesn't support it
        expect(capabilities.hasCommandLog).toBe(false);
      }
    });

    it('should retrieve COMMANDLOG with specific type', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasCommandLog) {
        const slowCommands = await adapter.getCommandLog(10, 'slow');
        expect(Array.isArray(slowCommands)).toBe(true);

        const largeRequests = await adapter.getCommandLog(10, 'large-request');
        expect(Array.isArray(largeRequests)).toBe(true);

        const largeReplies = await adapter.getCommandLog(10, 'large-reply');
        expect(Array.isArray(largeReplies)).toBe(true);
      }
    });

    it('should retrieve COMMANDLOG length', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasCommandLog) {
        const length = await adapter.getCommandLogLength();
        expect(typeof length).toBe('number');
        expect(length).toBeGreaterThanOrEqual(0);

        const slowLength = await adapter.getCommandLogLength('slow');
        expect(typeof slowLength).toBe('number');
        expect(slowLength).toBeGreaterThanOrEqual(0);
      }
    });

    it('should reset COMMANDLOG', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasCommandLog) {
        await expect(adapter.resetCommandLog()).resolves.not.toThrow();
        await expect(adapter.resetCommandLog('slow')).resolves.not.toThrow();
        await expect(adapter.resetCommandLog('large-request')).resolves.not.toThrow();
        await expect(adapter.resetCommandLog('large-reply')).resolves.not.toThrow();
      }
    });
  });

  describe('CLUSTER SLOT-STATS (Valkey 8.0+)', () => {
    it('should handle CLUSTER SLOT-STATS appropriately', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasClusterSlotStats) {
        // Note: This will fail if cluster mode is not enabled
        try {
          const stats = await adapter.getClusterSlotStats();
          expect(stats).toBeDefined();
        } catch (error: any) {
          // If cluster mode is disabled, we expect a specific error
          expect(error.message).toMatch(/cluster|disabled/i);
        }
      }
    });

    it('should support different ordering for CLUSTER SLOT-STATS', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasClusterSlotStats) {
        try {
          const keyCountStats = await adapter.getClusterSlotStats('key-count', 10);
          expect(keyCountStats).toBeDefined();

          const cpuStats = await adapter.getClusterSlotStats('cpu-usec', 10);
          expect(cpuStats).toBeDefined();
        } catch (error: any) {
          // Cluster mode might be disabled
          expect(error.message).toMatch(/cluster|disabled/i);
        }
      }
    });
  });
});
