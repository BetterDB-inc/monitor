import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connection-registry.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { DatabasePort } from '../../common/interfaces/database-port.interface';
import { DatabaseConnectionConfig } from '@betterdb/shared';

// Mock UnifiedDatabaseAdapter
jest.mock('../../database/adapters/unified.adapter', () => ({
  UnifiedDatabaseAdapter: jest.fn().mockImplementation((config) => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getCapabilities: jest.fn().mockReturnValue({
      dbType: 'valkey',
      version: '8.0.0',
      hasCommandLog: true,
      hasSlotStats: true,
      hasClusterSlotStats: true,
      hasLatencyMonitor: true,
      hasAclLog: true,
      hasMemoryDoctor: true,
    }),
    _config: config,
  })),
}));

describe('ConnectionRegistry', () => {
  let registry: ConnectionRegistry;
  let mockStorage: jest.Mocked<StoragePort>;
  let mockConfigService: jest.Mocked<ConfigService>;

  const createMockStorage = (): jest.Mocked<StoragePort> => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    isReady: jest.fn().mockReturnValue(true),
    getConnections: jest.fn().mockResolvedValue([]),
    saveConnection: jest.fn().mockResolvedValue(undefined),
    getConnection: jest.fn().mockResolvedValue(null),
    deleteConnection: jest.fn().mockResolvedValue(undefined),
    updateConnection: jest.fn().mockResolvedValue(undefined),
    // Other methods not used in these tests
    saveAclEntries: jest.fn(),
    getAclEntries: jest.fn(),
    getAuditStats: jest.fn(),
    pruneOldEntries: jest.fn(),
    saveClientSnapshot: jest.fn(),
    getClientSnapshots: jest.fn(),
    getClientTimeSeries: jest.fn(),
    getClientAnalyticsStats: jest.fn(),
    getClientConnectionHistory: jest.fn(),
    pruneOldClientSnapshots: jest.fn(),
    saveAnomalyEvent: jest.fn(),
    saveAnomalyEvents: jest.fn(),
    getAnomalyEvents: jest.fn(),
    getAnomalyStats: jest.fn(),
    resolveAnomaly: jest.fn(),
    pruneOldAnomalyEvents: jest.fn(),
    saveCorrelatedGroup: jest.fn(),
    getCorrelatedGroups: jest.fn(),
    pruneOldCorrelatedGroups: jest.fn(),
    saveKeyPatternSnapshots: jest.fn(),
    getKeyPatternSnapshots: jest.fn(),
    getKeyAnalyticsSummary: jest.fn(),
    getKeyPatternTrends: jest.fn(),
    pruneOldKeyPatternSnapshots: jest.fn(),
    getSettings: jest.fn(),
    saveSettings: jest.fn(),
    updateSettings: jest.fn(),
    createWebhook: jest.fn(),
    getWebhook: jest.fn(),
    getWebhooksByInstance: jest.fn(),
    getWebhooksByEvent: jest.fn(),
    updateWebhook: jest.fn(),
    deleteWebhook: jest.fn(),
    createDelivery: jest.fn(),
    getDelivery: jest.fn(),
    getDeliveriesByWebhook: jest.fn(),
    updateDelivery: jest.fn(),
    getRetriableDeliveries: jest.fn(),
    pruneOldDeliveries: jest.fn(),
    saveSlowLogEntries: jest.fn(),
    getSlowLogEntries: jest.fn(),
    getLatestSlowLogId: jest.fn(),
    pruneOldSlowLogEntries: jest.fn(),
    saveCommandLogEntries: jest.fn(),
    getCommandLogEntries: jest.fn(),
    getLatestCommandLogId: jest.fn(),
    pruneOldCommandLogEntries: jest.fn(),
  } as unknown as jest.Mocked<StoragePort>);

  beforeEach(async () => {
    mockStorage = createMockStorage();
    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'database') {
          return {
            host: 'localhost',
            port: 6379,
            username: 'default',
            password: 'testpass',
          };
        }
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionRegistry,
        { provide: 'STORAGE_CLIENT', useValue: mockStorage },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    registry = module.get<ConnectionRegistry>(ConnectionRegistry);
  });

  describe('onModuleInit', () => {
    it('should create default connection from env when no saved connections', async () => {
      mockStorage.getConnections.mockResolvedValue([]);

      await registry.onModuleInit();

      expect(mockStorage.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'env-default',
          name: 'Default',
          host: 'localhost',
          port: 6379,
          isDefault: true,
        }),
      );
      expect(registry.getDefaultId()).toBe('env-default');
    });

    it('should load saved connections on init', async () => {
      const savedConfig: DatabaseConnectionConfig = {
        id: 'saved-conn-1',
        name: 'Saved Connection',
        host: 'redis.example.com',
        port: 6380,
        isDefault: true,
        createdAt: Date.now(),
      };
      mockStorage.getConnections.mockResolvedValue([savedConfig]);

      await registry.onModuleInit();

      expect(registry.getDefaultId()).toBe('saved-conn-1');
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].name).toBe('Saved Connection');
    });

    it('should set first connection as default if none marked', async () => {
      const savedConfig: DatabaseConnectionConfig = {
        id: 'conn-no-default',
        name: 'No Default Flag',
        host: 'localhost',
        port: 6379,
        isDefault: false,
        createdAt: Date.now(),
      };
      mockStorage.getConnections.mockResolvedValue([savedConfig]);

      await registry.onModuleInit();

      expect(registry.getDefaultId()).toBe('conn-no-default');
      expect(mockStorage.updateConnection).toHaveBeenCalledWith('conn-no-default', { isDefault: true });
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should return default connection when no id provided', () => {
      const conn = registry.get();
      expect(conn).toBeDefined();
      expect(conn.isConnected()).toBe(true);
    });

    it('should return specific connection by id', () => {
      const conn = registry.get('env-default');
      expect(conn).toBeDefined();
    });

    it('should throw when connection not found', () => {
      expect(() => registry.get('non-existent')).toThrow('Connection non-existent not found');
    });

    it('should throw when no default and no id provided', async () => {
      // Create registry without initializing
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConnectionRegistry,
          { provide: 'STORAGE_CLIENT', useValue: mockStorage },
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();
      const emptyRegistry = module.get<ConnectionRegistry>(ConnectionRegistry);

      expect(() => emptyRegistry.get()).toThrow('No connection available');
    });
  });

  describe('getConfig', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should return config for default connection', () => {
      const config = registry.getConfig();
      expect(config).toBeDefined();
      expect(config?.host).toBe('localhost');
      expect(config?.port).toBe(6379);
    });

    it('should return config for specific id', () => {
      const config = registry.getConfig('env-default');
      expect(config).toBeDefined();
      expect(config?.id).toBe('env-default');
    });

    it('should return null for non-existent id', () => {
      const config = registry.getConfig('non-existent');
      expect(config).toBeNull();
    });
  });

  describe('addConnection', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should add a new connection successfully', async () => {
      const id = await registry.addConnection({
        name: 'New Connection',
        host: 'new-redis.example.com',
        port: 6380,
      });

      expect(id).toBeDefined();
      expect(id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(mockStorage.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Connection',
          host: 'new-redis.example.com',
          port: 6380,
          isDefault: false,
        }),
      );
    });

    it('should throw when connection test fails', async () => {
      // Make the adapter's connect fail for test
      const { UnifiedDatabaseAdapter } = require('../../database/adapters/unified.adapter');
      UnifiedDatabaseAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
        disconnect: jest.fn().mockResolvedValue(undefined),
      }));

      await expect(
        registry.addConnection({
          name: 'Bad Connection',
          host: 'bad-host',
          port: 9999,
        }),
      ).rejects.toThrow('Connection refused');
    });
  });

  describe('removeConnection', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should not allow removing env-default connection', async () => {
      await expect(registry.removeConnection('env-default')).rejects.toThrow(
        'Cannot remove the default environment connection',
      );
    });

    it('should remove a user-added connection', async () => {
      const id = await registry.addConnection({
        name: 'Temp Connection',
        host: 'temp.example.com',
        port: 6379,
      });

      await registry.removeConnection(id);

      expect(mockStorage.deleteConnection).toHaveBeenCalledWith(id);
      expect(() => registry.get(id)).toThrow(`Connection ${id} not found`);
    });

    it('should update default when removing default connection', async () => {
      // Add two connections
      const id1 = await registry.addConnection({
        name: 'Conn 1',
        host: 'host1.example.com',
        port: 6379,
      });
      const id2 = await registry.addConnection({
        name: 'Conn 2',
        host: 'host2.example.com',
        port: 6379,
      });

      // Set id1 as default
      await registry.setDefault(id1);

      // Remove id1
      await registry.removeConnection(id1);

      // Default should now be either env-default or id2
      const newDefault = registry.getDefaultId();
      expect(newDefault).toBeDefined();
      expect(newDefault).not.toBe(id1);
    });
  });

  describe('setDefault', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should set a connection as default', async () => {
      const id = await registry.addConnection({
        name: 'New Default',
        host: 'default.example.com',
        port: 6379,
      });

      await registry.setDefault(id);

      expect(registry.getDefaultId()).toBe(id);
      expect(mockStorage.updateConnection).toHaveBeenCalledWith(id, { isDefault: true });
    });

    it('should unmark old default when setting new default', async () => {
      const id = await registry.addConnection({
        name: 'New Default',
        host: 'default.example.com',
        port: 6379,
      });

      const oldDefault = registry.getDefaultId();
      await registry.setDefault(id);

      expect(mockStorage.updateConnection).toHaveBeenCalledWith(oldDefault, { isDefault: false });
    });

    it('should throw when connection not found', async () => {
      await expect(registry.setDefault('non-existent')).rejects.toThrow('Connection non-existent not found');
    });
  });

  describe('testConnection', () => {
    it('should return success for valid connection', async () => {
      const result = await registry.testConnection({
        name: 'Test',
        host: 'localhost',
        port: 6379,
      });

      expect(result.success).toBe(true);
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities?.dbType).toBe('valkey');
    });

    it('should return error for invalid connection', async () => {
      const { UnifiedDatabaseAdapter } = require('../../database/adapters/unified.adapter');
      UnifiedDatabaseAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        disconnect: jest.fn(),
      }));

      const result = await registry.testConnection({
        name: 'Bad Test',
        host: 'invalid-host',
        port: 9999,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should return all connections with status', () => {
      const list = registry.list();

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'env-default',
        name: 'Default',
        host: 'localhost',
        port: 6379,
        isConnected: true,
        isDefault: true,
      });
    });

    it('should include capabilities for connected instances', () => {
      const list = registry.list();

      expect(list[0].capabilities).toBeDefined();
      expect(list[0].capabilities?.dbType).toBe('valkey');
      expect(list[0].capabilities?.version).toBe('8.0.0');
    });
  });

  describe('reconnect', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should reconnect an existing connection', async () => {
      await registry.reconnect('env-default');

      // Should have created a new adapter and connected
      const conn = registry.get('env-default');
      expect(conn.isConnected()).toBe(true);
    });

    it('should throw when connection not found', async () => {
      await expect(registry.reconnect('non-existent')).rejects.toThrow('Connection non-existent not found');
    });
  });

  describe('findIdByHostPort', () => {
    beforeEach(async () => {
      mockStorage.getConnections.mockResolvedValue([]);
      await registry.onModuleInit();
    });

    it('should find connection by host and port', () => {
      const id = registry.findIdByHostPort('localhost', 6379);
      expect(id).toBe('env-default');
    });

    it('should return null when not found', () => {
      const id = registry.findIdByHostPort('unknown', 9999);
      expect(id).toBeNull();
    });
  });

  describe('isEnvDefault', () => {
    it('should return true for env-default id', () => {
      expect(registry.isEnvDefault('env-default')).toBe(true);
    });

    it('should return false for other ids', () => {
      expect(registry.isEnvDefault('some-other-id')).toBe(false);
    });
  });
});
