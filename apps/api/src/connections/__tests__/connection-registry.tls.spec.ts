import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConnectionRegistry } from '../connection-registry.service';
import { ENV_DEFAULT_ID } from '../connection.constants';
import { RuntimeCapabilityTracker } from '../runtime-capability-tracker.service';
import { SshTunnelService } from '../../database/ssh/ssh-tunnel.service';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { DatabaseConnectionConfig, TlsConfig } from '@betterdb/shared';
import { resetEncryptionService, EnvelopeEncryptionService } from '../../common/utils/encryption';

jest.mock('../../database/adapters/unified.adapter', () => ({
  UnifiedDatabaseAdapter: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getActiveDbIndex: jest.fn().mockReturnValue(0),
    getAuthenticatedUser: jest.fn().mockReturnValue('monitor-mtls'),
    getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '9.1.0' }),
  })),
}));

const KEY = 'test-encryption-key-for-tests';
const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

describe('ConnectionRegistry TLS material', () => {
  let registry: ConnectionRegistry;
  let storage: jest.Mocked<Pick<StoragePort, 'getConnections' | 'saveConnection' | 'updateConnection' | 'getConnection' | 'deleteConnection'>>;
  let database: Record<string, unknown>;
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalHost = process.env.DB_HOST;
  const enc = new EnvelopeEncryptionService(KEY);

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

  beforeEach(async () => {
    resetEncryptionService();
    storage = {
      getConnections: jest.fn().mockResolvedValue([]),
      saveConnection: jest.fn().mockResolvedValue(undefined),
      updateConnection: jest.fn().mockResolvedValue(undefined),
      getConnection: jest.fn().mockResolvedValue(null),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
    };
    database = { host: 'localhost', port: 6379, username: 'default', password: '' };
    const configService = {
      get: jest.fn().mockImplementation((key: string) => (key === 'database' ? database : undefined)),
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
  });

  const saved = (overrides: Partial<DatabaseConnectionConfig>): DatabaseConnectionConfig => ({
    id: 'c1',
    name: 'mTLS',
    host: 'cache.internal',
    port: 6380,
    tls: true,
    isDefault: true,
    createdAt: 1,
    ...overrides,
  });

  const encryptedTls = (): TlsConfig => ({
    source: 'inline',
    cert: CERT,
    key: enc.encrypt(PRIVATE_KEY),
    passphrase: enc.encrypt('pw'),
    secretsEncrypted: true,
  });

  it('decrypts the TLS key alongside an encrypted password (every decrypt branch returns it)', async () => {
    storage.getConnections.mockResolvedValue([
      saved({ password: enc.encrypt('db-password'), passwordEncrypted: true, tlsConfig: encryptedTls() }),
    ]);

    await registry.onModuleInit();

    const config = registry.getConfig('c1');
    expect(config?.password).toBe('db-password');
    expect(config?.tlsConfig).toEqual({ source: 'inline', cert: CERT, key: PRIVATE_KEY, passphrase: 'pw', secretsEncrypted: false });
    expect(config?.credentialStatus).toBe('valid');
  });

  it('reports an undecryptable TLS key as decryption_failed and never passes the ciphertext on', async () => {
    storage.getConnections.mockResolvedValue([
      saved({ tlsConfig: { ...encryptedTls(), key: 'not-ciphertext' } }),
    ]);

    await registry.onModuleInit();

    const config = registry.getConfig('c1');
    expect(config?.credentialStatus).toBe('decryption_failed');
    expect(config?.credentialError).toMatch(/Failed to decrypt TLS client key/);
    expect(config?.tlsConfig?.key).toBeUndefined();
    expect(config?.tlsConfig?.cert).toBe(CERT);
  });

  it('encrypts the private key and passphrase when saving a new connection', async () => {
    await registry.addConnection({
      name: 'mtls',
      host: 'cache.internal',
      port: 6380,
      tls: true,
      authMode: 'certificate',
      tlsConfig: { cert: CERT, key: PRIVATE_KEY, passphrase: 'pw' },
    });

    const persisted = storage.saveConnection.mock.calls[0][0];
    expect(persisted.tlsConfig?.secretsEncrypted).toBe(true);
    // Pasted PEM is trimmed on input; the content is otherwise untouched.
    expect(persisted.tlsConfig?.cert).toBe(CERT.trim());
    expect(persisted.tlsConfig?.key).not.toBe(PRIVATE_KEY.trim());
    expect(enc.decrypt(persisted.tlsConfig!.key!)).toBe(PRIVATE_KEY.trim());
    expect(enc.decrypt(persisted.tlsConfig!.passphrase!)).toBe('pw');
    expect(persisted.authMode).toBe('certificate');
  });

  it('rejects TLS settings on an external (OTLP push) test the same way save does', async () => {
    const result = await registry.testConnection({
      name: 'otlp',
      host: 'collector',
      port: 4318,
      connectionType: 'external',
      tls: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OTLP push connections take no credentials, TLS or SSH tunnel/);
    expect(
      (await registry.testConnection({ name: 'otlp', host: 'collector', port: 4318, connectionType: 'external' })).success,
    ).toBe(true);
  });

  it('exposes the live ACL user and a redacted TLS summary in the status list', async () => {
    const id = await registry.addConnection({
      name: 'mtls',
      host: 'cache.internal',
      port: 6380,
      tls: true,
      authMode: 'certificate',
      tlsConfig: { cert: CERT, key: PRIVATE_KEY },
    });
    const status = registry.list().find((c) => c.id === id);
    expect(status).toMatchObject({
      authMode: 'certificate',
      authenticatedUser: 'monitor-mtls',
      tlsConfig: { source: 'inline', hasCa: false, hasClientCert: true },
    });
    expect(JSON.stringify(status)).not.toContain('BEGIN');
  });

  describe('env-owned default connection', () => {
    const ROTATED_CERT = '-----BEGIN CERTIFICATE-----\nrotated\n-----END CERTIFICATE-----\n';

    it('replaces the persisted TLS material with the environment\'s on startup', async () => {
      storage.getConnections.mockResolvedValue([
        saved({ id: ENV_DEFAULT_ID, name: 'Default', tlsConfig: encryptedTls() }),
      ]);
      database.tls = true;
      database.tlsConfig = { source: 'inline', cert: ROTATED_CERT, key: PRIVATE_KEY };
      database.authMode = 'certificate';

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config?.tlsConfig?.cert).toBe(ROTATED_CERT);
      expect(config?.tlsConfig?.key).toBe(PRIVATE_KEY);
      expect(config?.authMode).toBe('certificate');
      const persisted = storage.saveConnection.mock.calls.at(-1)![0];
      expect(persisted.id).toBe(ENV_DEFAULT_ID);
      expect(persisted.tlsConfig?.cert).toBe(ROTATED_CERT);
      expect(persisted.tlsConfig?.secretsEncrypted).toBe(true);
      expect(enc.decrypt(persisted.tlsConfig!.key!)).toBe(PRIVATE_KEY);
    });

    it('clears persisted material when the environment no longer provides any', async () => {
      storage.getConnections.mockResolvedValue([
        saved({ id: ENV_DEFAULT_ID, name: 'Default', tlsConfig: encryptedTls(), authMode: 'certificate' }),
      ]);

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config?.tlsConfig).toBeUndefined();
      expect(config?.authMode).toBeUndefined();
      expect(storage.saveConnection).toHaveBeenCalled();
    });

    it('does not rewrite the record when the material is unchanged', async () => {
      storage.getConnections.mockResolvedValue([
        saved({ id: ENV_DEFAULT_ID, name: 'Default', tlsConfig: encryptedTls() }),
      ]);
      database.tls = true;
      database.tlsConfig = { source: 'inline', cert: CERT, key: PRIVATE_KEY, passphrase: 'pw' };

      await registry.onModuleInit();

      expect(registry.getConfig(ENV_DEFAULT_ID)?.tlsConfig?.cert).toBe(CERT);
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });

    it('leaves UI-added connections alone', async () => {
      storage.getConnections.mockResolvedValue([saved({ tlsConfig: encryptedTls() })]);
      database.tls = true;
      database.tlsConfig = { source: 'inline', cert: ROTATED_CERT, key: PRIVATE_KEY };

      await registry.onModuleInit();

      expect(registry.getConfig('c1')?.tlsConfig?.cert).toBe(CERT);
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });
  });
});
