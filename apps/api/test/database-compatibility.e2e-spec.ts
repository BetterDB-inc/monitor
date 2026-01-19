import { Test, TestingModule } from '@nestjs/testing';
import { UnifiedDatabaseAdapter } from '../src/database/adapters/unified.adapter';

describe('Database Compatibility (E2E)', () => {
  let adapter: UnifiedDatabaseAdapter;

  // Common tests that work with both Redis and Valkey
  // Use TEST_DB_HOST and TEST_DB_PORT to override defaults
  // Default to Redis on 6382 (from docker-compose.yml)
  const DB_CONFIG = {
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '6382', 10),
    username: process.env.TEST_DB_USERNAME || 'default',
    password: process.env.TEST_DB_PASSWORD || 'devpassword',
  };

  beforeAll(async () => {
    adapter = new UnifiedDatabaseAdapter(DB_CONFIG);
    await adapter.connect();
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.disconnect();
    }
  });

  describe('Connection and Capability Detection', () => {
    it('should connect and detect database type', () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities).toBeDefined();
      expect(capabilities.dbType).toMatch(/^(redis|valkey)$/);
      expect(capabilities.version).toBeDefined();
    });

    it('should have basic capabilities enabled', () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities.hasLatencyMonitor).toBe(true);
      expect(capabilities.hasMemoryDoctor).toBe(true);
    });

    it('should have ACL log for Redis 6+', () => {
      const capabilities = adapter.getCapabilities();
      const version = capabilities.version.split('.').map(v => parseInt(v, 10));
      const majorVersion = version[0] || 0;

      if (majorVersion >= 6) {
        expect(capabilities.hasAclLog).toBe(true);
      }
    });
  });

  describe('Basic Commands', () => {
    it('should successfully ping', async () => {
      const result = await adapter.ping();
      expect(result).toBe(true);
    });

    it('should retrieve INFO', async () => {
      const info = await adapter.getInfo();
      expect(info).toBeDefined();
      expect(typeof info).toBe('object');
    });

    it('should retrieve parsed INFO', async () => {
      const info = await adapter.getInfoParsed(['server']);
      expect(info).toBeDefined();
      expect(info.server).toBeDefined();
    });

    it('should retrieve database size', async () => {
      const size = await adapter.getDbSize();
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it('should retrieve last save time', async () => {
      const lastSave = await adapter.getLastSaveTime();
      expect(typeof lastSave).toBe('number');
      expect(lastSave).toBeGreaterThan(0);
    });
  });

  describe('Slowlog', () => {
    it('should retrieve SLOWLOG', async () => {
      const slowLog = await adapter.getSlowLog(10);
      expect(Array.isArray(slowLog)).toBe(true);
    });

    it('should retrieve SLOWLOG length', async () => {
      const length = await adapter.getSlowLogLength();
      expect(typeof length).toBe('number');
      expect(length).toBeGreaterThanOrEqual(0);
    });

    it('should reset SLOWLOG', async () => {
      await expect(adapter.resetSlowLog()).resolves.not.toThrow();
    });
  });

  describe('Client Management', () => {
    it('should retrieve CLIENT LIST', async () => {
      const clients = await adapter.getClients();
      expect(Array.isArray(clients)).toBe(true);
      // Should at least have our own connection
      expect(clients.length).toBeGreaterThan(0);
    });

    it('should retrieve client by ID', async () => {
      const clients = await adapter.getClients();
      if (clients.length > 0) {
        const client = await adapter.getClientById(clients[0].id);
        expect(client).toBeDefined();
        expect(client?.id).toBe(clients[0].id);
      }
    });
  });

  describe('Memory Stats', () => {
    it('should retrieve MEMORY STATS', async () => {
      const stats = await adapter.getMemoryStats();
      expect(stats).toBeDefined();
      expect(typeof stats).toBe('object');
    });

    it('should retrieve MEMORY DOCTOR', async () => {
      const doctor = await adapter.getMemoryDoctor();
      expect(typeof doctor).toBe('string');
    });
  });

  describe('Latency Monitoring', () => {
    it('should retrieve LATENCY LATEST', async () => {
      const events = await adapter.getLatestLatencyEvents();
      expect(Array.isArray(events)).toBe(true);
    });

    it('should retrieve LATENCY DOCTOR', async () => {
      const doctor = await adapter.getLatencyDoctor();
      expect(typeof doctor).toBe('string');
    });

    it('should retrieve LATENCY HISTOGRAM', async () => {
      const histogram = await adapter.getLatencyHistogram();
      expect(typeof histogram).toBe('object');
    });

    it('should reset latency events', async () => {
      await expect(adapter.resetLatencyEvents()).resolves.not.toThrow();
    });
  });

  describe('ACL Log (Redis 6+)', () => {
    it('should retrieve ACL LOG if supported', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasAclLog) {
        const aclLog = await adapter.getAclLog(10);
        expect(Array.isArray(aclLog)).toBe(true);
      }
    });

    it('should reset ACL LOG if supported', async () => {
      const capabilities = adapter.getCapabilities();

      if (capabilities.hasAclLog) {
        await expect(adapter.resetAclLog()).resolves.not.toThrow();
      }
    });
  });

  describe('Role Information', () => {
    it('should retrieve ROLE', async () => {
      const role = await adapter.getRole();
      expect(role).toBeDefined();
      expect(role.role).toBeDefined();
      expect(['master', 'slave', 'sentinel']).toContain(role.role);
    });
  });

  describe('Config Management', () => {
    it('should retrieve CONFIG values', async () => {
      const maxMemory = await adapter.getConfigValue('maxmemory');
      // Config value can be null if not set
      expect(maxMemory === null || typeof maxMemory === 'string').toBe(true);
    });

    it('should retrieve multiple CONFIG values', async () => {
      const configs = await adapter.getConfigValues('max*');
      expect(typeof configs).toBe('object');
    });
  });
});
