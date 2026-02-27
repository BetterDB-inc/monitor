import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConfigMonitorService } from '../config-monitor.service';
import { WebhookEventsEnterpriseService } from '../webhook-events-enterprise.service';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { SettingsService } from '@app/settings/settings.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ConnectionContext } from '@app/common/services/multi-connection-poller';

describe('ConfigMonitorService', () => {
  let service: ConfigMonitorService;
  let webhookEventsEnterpriseService: jest.Mocked<WebhookEventsEnterpriseService>;
  let dbClient: jest.Mocked<DatabasePort>;
  let connectionRegistry: jest.Mocked<ConnectionRegistry>;
  let configService: jest.Mocked<ConfigService>;
  let settingsService: jest.Mocked<SettingsService>;
  let mockContext: ConnectionContext;

  beforeEach(async () => {
    webhookEventsEnterpriseService = {
      dispatchAclModified: jest.fn(),
      dispatchConfigChanged: jest.fn(),
    } as any;

    dbClient = {
      getCapabilities: jest.fn().mockReturnValue({
        dbType: 'valkey',
        version: '8.0.0',
        hasCommandLog: true,
        hasSlotStats: true,
        hasClusterSlotStats: true,
        hasLatencyMonitor: true,
        hasAclLog: true,
        hasMemoryDoctor: true,
        hasConfig: true,
      }),
      getAclUsers: jest.fn().mockResolvedValue([]),
      getAclList: jest.fn().mockResolvedValue([]),
      getConfigValues: jest.fn().mockResolvedValue({}),
    } as any;

    mockContext = {
      connectionId: 'test-connection',
      connectionName: 'Test Connection',
      client: dbClient,
      host: 'localhost',
      port: 6379,
    };

    connectionRegistry = {
      get: jest.fn().mockReturnValue(dbClient),
      getDefaultId: jest.fn().mockReturnValue('test-connection'),
      list: jest.fn().mockReturnValue([{
        id: 'test-connection',
        name: 'Test Connection',
        host: 'localhost',
        port: 6379,
        isConnected: true,
      }]),
    } as any;

    configService = {
      get: jest.fn((key: string, defaultValue: any) => {
        if (key === 'database.host') return 'localhost';
        if (key === 'database.port') return 6379;
        return defaultValue;
      }),
    } as any;

    settingsService = {} as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigMonitorService,
        {
          provide: ConnectionRegistry,
          useValue: connectionRegistry,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: SettingsService,
          useValue: settingsService,
        },
        {
          provide: WebhookEventsEnterpriseService,
          useValue: webhookEventsEnterpriseService,
        },
      ],
    }).compile();

    service = module.get<ConfigMonitorService>(ConfigMonitorService);
  });

  describe('ACL Change Detection', () => {
    describe('acl.modified - user_added', () => {
      it('should dispatch acl.modified when new user is added', async () => {
        // Initial state: 1 user
        dbClient.getAclUsers
          .mockResolvedValueOnce(['default'])
          .mockResolvedValueOnce(['default', 'newuser']);

        dbClient.getAclList
          .mockResolvedValueOnce(['user default on >password ~*'])
          .mockResolvedValueOnce([
            'user default on >password ~*',
            'user newuser on >password ~*',
          ]);

        // Capture initial state
        await (service as any).captureInitialState(mockContext);

        // Check for changes
        await (service as any).checkAclChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchAclModified).toHaveBeenCalledWith({
          changeType: 'user_added',
          affectedUser: 'newuser',
          connectionId: 'test-connection',
          timestamp: expect.any(Number),
          instance: { host: 'localhost', port: 6379, connectionId: 'test-connection' },
        });
      });
    });

    describe('acl.modified - user_removed', () => {
      it('should dispatch acl.modified when user is removed', async () => {
        // Initial state: 2 users
        dbClient.getAclUsers
          .mockResolvedValueOnce(['default', 'olduser'])
          .mockResolvedValueOnce(['default']);

        dbClient.getAclList
          .mockResolvedValueOnce([
            'user default on >password ~*',
            'user olduser on >password ~*',
          ])
          .mockResolvedValueOnce(['user default on >password ~*']);

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkAclChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchAclModified).toHaveBeenCalledWith({
          changeType: 'user_removed',
          affectedUser: 'olduser',
          connectionId: 'test-connection',
          timestamp: expect.any(Number),
          instance: { host: 'localhost', port: 6379, connectionId: 'test-connection' },
        });
      });
    });

    describe('acl.modified - permissions_changed', () => {
      it('should dispatch acl.modified when user permissions change', async () => {
        // Initial permissions
        dbClient.getAclUsers
          .mockResolvedValueOnce(['default', 'testuser'])
          .mockResolvedValueOnce(['default', 'testuser']);

        dbClient.getAclList
          .mockResolvedValueOnce([
            'user default on >password ~*',
            'user testuser on >password ~keys:*',
          ])
          .mockResolvedValueOnce([
            'user default on >password ~*',
            'user testuser on >newpassword ~*', // Permissions changed
          ]);

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkAclChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchAclModified).toHaveBeenCalledWith({
          changeType: 'permissions_changed',
          affectedUser: 'testuser',
          connectionId: 'test-connection',
          timestamp: expect.any(Number),
          instance: { host: 'localhost', port: 6379, connectionId: 'test-connection' },
        });
      });

      it('should not dispatch if permissions are unchanged', async () => {
        const aclUsers = ['default'];
        const aclList = ['user default on >password ~*'];

        dbClient.getAclUsers
          .mockResolvedValueOnce(aclUsers)
          .mockResolvedValueOnce(aclUsers);

        dbClient.getAclList
          .mockResolvedValueOnce(aclList)
          .mockResolvedValueOnce(aclList);

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkAclChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchAclModified).not.toHaveBeenCalled();
      });
    });
  });

  describe('Config Change Detection', () => {
    describe('config.changed', () => {
      it('should dispatch config.changed when config value changes', async () => {
        dbClient.getConfigValues
          .mockResolvedValueOnce({ maxmemory: '100mb', timeout: '0' })
          .mockResolvedValueOnce({ maxmemory: '200mb', timeout: '0' });

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkConfigChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchConfigChanged).toHaveBeenCalledWith({
          configKey: 'maxmemory',
          oldValue: '100mb',
          newValue: '200mb',
          connectionId: 'test-connection',
          timestamp: expect.any(Number),
          instance: { host: 'localhost', port: 6379, connectionId: 'test-connection' },
        });
      });

      it('should dispatch multiple config.changed for multiple changes', async () => {
        dbClient.getConfigValues
          .mockResolvedValueOnce({
            maxmemory: '100mb',
            timeout: '0',
            'maxmemory-policy': 'noeviction',
          })
          .mockResolvedValueOnce({
            maxmemory: '200mb',
            timeout: '300',
            'maxmemory-policy': 'allkeys-lru',
          });

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkConfigChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchConfigChanged).toHaveBeenCalledTimes(3);
        expect(webhookEventsEnterpriseService.dispatchConfigChanged).toHaveBeenCalledWith(
          expect.objectContaining({
            configKey: 'maxmemory',
            oldValue: '100mb',
            newValue: '200mb',
          })
        );
        expect(webhookEventsEnterpriseService.dispatchConfigChanged).toHaveBeenCalledWith(
          expect.objectContaining({
            configKey: 'timeout',
            oldValue: '0',
            newValue: '300',
          })
        );
        expect(webhookEventsEnterpriseService.dispatchConfigChanged).toHaveBeenCalledWith(
          expect.objectContaining({
            configKey: 'maxmemory-policy',
            oldValue: 'noeviction',
            newValue: 'allkeys-lru',
          })
        );
      });

      it('should not dispatch if config is unchanged', async () => {
        const config = { maxmemory: '100mb', timeout: '0' };

        dbClient.getConfigValues
          .mockResolvedValueOnce(config)
          .mockResolvedValueOnce(config);

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkConfigChanges(mockContext);

        expect(webhookEventsEnterpriseService.dispatchConfigChanged).not.toHaveBeenCalled();
      });

      it('should handle new config keys being added', async () => {
        dbClient.getConfigValues
          .mockResolvedValueOnce({ maxmemory: '100mb' })
          .mockResolvedValueOnce({ maxmemory: '100mb', timeout: '300' });

        await (service as any).captureInitialState(mockContext);
        await (service as any).checkConfigChanges(mockContext);

        // Should not dispatch for new keys (only for changed existing keys)
        expect(webhookEventsEnterpriseService.dispatchConfigChanged).not.toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle ACL errors gracefully', async () => {
      // Set up initial state successfully first
      dbClient.getAclUsers.mockResolvedValueOnce(['default']);
      dbClient.getAclList.mockResolvedValueOnce(['user default on >password ~*']);
      dbClient.getConfigValues.mockResolvedValueOnce({ maxmemory: '100mb' });

      await (service as any).captureInitialState(mockContext);

      // Now make the check fail
      dbClient.getAclUsers.mockRejectedValue(new Error('ACL error'));

      await (service as any).checkAclChanges(mockContext);

      expect(webhookEventsEnterpriseService.dispatchAclModified).not.toHaveBeenCalled();
    });

    it('should handle config errors gracefully', async () => {
      dbClient.getConfigValues
        .mockResolvedValueOnce({ maxmemory: '100mb' })
        .mockRejectedValueOnce(new Error('Config error'));

      await (service as any).captureInitialState(mockContext);
      await (service as any).checkConfigChanges(mockContext);

      expect(webhookEventsEnterpriseService.dispatchConfigChanged).not.toHaveBeenCalled();
    });

    it('should not start polling if ACL not supported', async () => {
      dbClient.getCapabilities.mockReturnValue({
        dbType: 'valkey',
        version: '8.0.0',
        hasCommandLog: true,
        hasSlotStats: true,
        hasClusterSlotStats: true,
        hasLatencyMonitor: true,
        hasAclLog: false,
        hasMemoryDoctor: true,
        hasConfig: true,
      });

      // onModuleInit should not throw
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should skip config monitoring when CONFIG is not available', async () => {
      dbClient.getCapabilities.mockReturnValue({
        dbType: 'valkey',
        version: '8.0.0',
        hasCommandLog: true,
        hasSlotStats: true,
        hasClusterSlotStats: true,
        hasLatencyMonitor: true,
        hasAclLog: true,
        hasMemoryDoctor: true,
        hasConfig: false,
      });

      // ACL works fine
      dbClient.getAclUsers
        .mockResolvedValueOnce(['default'])
        .mockResolvedValueOnce(['default', 'newuser']);
      dbClient.getAclList
        .mockResolvedValueOnce(['user default on >password ~*'])
        .mockResolvedValueOnce([
          'user default on >password ~*',
          'user newuser on >password ~*',
        ]);

      // captureInitialState should succeed without calling getConfigValues
      await (service as any).captureInitialState(mockContext);
      expect(dbClient.getConfigValues).not.toHaveBeenCalled();

      // ACL changes should still be detected
      await (service as any).checkAclChanges(mockContext);
      expect(webhookEventsEnterpriseService.dispatchAclModified).toHaveBeenCalledWith(
        expect.objectContaining({ changeType: 'user_added', affectedUser: 'newuser' }),
      );
    });
  });

  describe('Username Extraction', () => {
    it('should extract username from ACL LIST entry', () => {
      const entry = 'user testuser on >password ~*';
      const username = (service as any).extractUsername(entry);
      expect(username).toBe('testuser');
    });

    it('should extract username with special characters', () => {
      const entry = 'user test-user_123 on >password ~*';
      const username = (service as any).extractUsername(entry);
      expect(username).toBe('test-user_123');
    });

    it('should return null for invalid format', () => {
      const entry = 'invalid acl entry';
      const username = (service as any).extractUsername(entry);
      expect(username).toBeNull();
    });
  });
});
