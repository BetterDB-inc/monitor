import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connection-registry.service';
import { RuntimeCapabilityTracker } from '../runtime-capability-tracker.service';
import { SshTunnelService } from '../../database/ssh/ssh-tunnel.service';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { resetEncryptionService } from '../../common/utils/encryption';

jest.mock('../../database/adapters/unified.adapter', () => ({
  UnifiedDatabaseAdapter: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getActiveDbIndex: jest.fn().mockReturnValue(0),
    getAuthenticatedUser: jest.fn().mockReturnValue('default'),
    getObservedHostKeyFingerprint: jest.fn().mockReturnValue(undefined),
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '9.1.0' }),
  })),
}));

const KEY = 'test-encryption-key-for-tests';

describe('ConnectionRegistry.pinLearnedSshHostKey', () => {
  let registry: ConnectionRegistry;
  let storage: jest.Mocked<Pick<StoragePort, 'getConnections' | 'saveConnection' | 'updateConnection' | 'getConnection' | 'deleteConnection'>>;
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalHost = process.env.DB_HOST;

  const tunnelled = (hostKeyFingerprint?: string): DatabaseConnectionConfig => ({
    id: 'c1',
    name: 'Tunnelled',
    host: 'cache.internal',
    port: 6379,
    isDefault: true,
    createdAt: 1,
    sshTunnel: {
      enabled: true,
      host: 'bastion',
      port: 22,
      username: 'ops',
      authMethod: 'password',
      password: 'ssh-pw',
      secretsEncrypted: false,
      ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
    },
  });

  const start = async (stored: DatabaseConnectionConfig[]): Promise<void> => {
    storage.getConnections.mockResolvedValue(stored);
    resetEncryptionService();
    const configService = {
      get: jest.fn().mockImplementation((key: string) =>
        key === 'database' ? { host: 'localhost', port: 6379, username: 'default', password: '' } : undefined,
      ),
    } as unknown as ConfigService;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionRegistry,
        RuntimeCapabilityTracker,
        SshTunnelService,
        ExternalMetricsStore,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();
    registry = module.get(ConnectionRegistry);
    await registry.onModuleInit();
    storage.saveConnection.mockClear();
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
    process.env.DB_HOST = 'localhost';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    if (originalHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = originalHost;
    resetEncryptionService();
  });

  beforeEach(() => {
    storage = {
      getConnections: jest.fn().mockResolvedValue([]),
      saveConnection: jest.fn().mockResolvedValue(undefined),
      updateConnection: jest.fn().mockResolvedValue(undefined),
      getConnection: jest.fn().mockResolvedValue(null),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('pins and stores a fingerprint for a tunnelled connection that has none', async () => {
    await start([tunnelled()]);

    await registry.pinLearnedSshHostKey('c1', 'SHA256:from-migration');

    expect(registry.getConfig('c1')?.sshTunnel?.hostKeyFingerprint).toBe('SHA256:from-migration');
    expect(storage.saveConnection).toHaveBeenCalledTimes(1);
    const [persisted] = storage.saveConnection.mock.calls[0];
    expect(persisted.sshTunnel).toMatchObject({ hostKeyFingerprint: 'SHA256:from-migration', secretsEncrypted: true });
    expect(persisted.sshTunnel?.password).not.toBe('ssh-pw');
  });

  it('keeps a fingerprint that is already pinned', async () => {
    await start([tunnelled('SHA256:pinned')]);

    await registry.pinLearnedSshHostKey('c1', 'SHA256:other');

    expect(registry.getConfig('c1')?.sshTunnel?.hostKeyFingerprint).toBe('SHA256:pinned');
    expect(storage.saveConnection).not.toHaveBeenCalled();
  });

  it('ignores a connection it does not know', async () => {
    await start([tunnelled()]);

    await expect(registry.pinLearnedSshHostKey('missing', 'SHA256:x')).resolves.toBeUndefined();

    expect(storage.saveConnection).not.toHaveBeenCalled();
  });
});
