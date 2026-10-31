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
    getObservedHostKeyFingerprint: jest.fn().mockReturnValue('SHA256:learned-on-first-use'),
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

  // Builds a registry against the current `storage` and `database` mocks with
  // whatever ENCRYPTION_KEY is in the environment at that moment.
  const buildRegistry = async (): Promise<ConnectionRegistry> => {
    resetEncryptionService();
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
    return module.get(ConnectionRegistry);
  };

  beforeEach(async () => {
    storage = {
      getConnections: jest.fn().mockResolvedValue([]),
      saveConnection: jest.fn().mockResolvedValue(undefined),
      updateConnection: jest.fn().mockResolvedValue(undefined),
      getConnection: jest.fn().mockResolvedValue(null),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
    };
    database = { host: 'localhost', port: 6379, username: 'default', password: '' };
    registry = await buildRegistry();
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

  it('drops TLS material when TLS is off instead of storing an unused private key', async () => {
    const id = await registry.addConnection({
      name: 'plain',
      host: 'cache.internal',
      port: 6379,
      tls: false,
      tlsConfig: { cert: CERT, key: PRIVATE_KEY },
    });
    expect(storage.saveConnection.mock.calls[0][0].tlsConfig).toBeUndefined();
    expect(registry.list().find((c) => c.id === id)?.tlsConfig).toBeUndefined();
    const test = await registry.testConnection({ name: 'plain', host: 'cache.internal', port: 6379, tls: false, tlsConfig: { cert: CERT, key: PRIVATE_KEY } });
    expect(test.success).toBe(true);
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

  describe('env-owned default connection follows the environment', () => {
    const ROTATED_CERT = '-----BEGIN CERTIFICATE-----\nrotated\n-----END CERTIFICATE-----\n';
    const envDefault = (overrides: Partial<DatabaseConnectionConfig> = {}) =>
      saved({ id: ENV_DEFAULT_ID, name: 'Default', host: 'localhost', port: 6379, username: 'default', password: '', ...overrides });

    it('rebuilds host, credentials, TLS flag, material and auth mode from DB_* on startup and persists them', async () => {
      storage.getConnections.mockResolvedValue([envDefault({ tls: false, tlsConfig: undefined })]);
      Object.assign(database, {
        host: 'cache.internal',
        port: 6380,
        username: 'monitor',
        password: 'rotated-password',
        tls: true,
        tlsConfig: { source: 'file', trustedPaths: true, certPath: '/etc/tls/client.crt', keyPath: '/etc/tls/client.key', passphrase: 'pw' },
        authMode: 'certificate',
      });

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config).toMatchObject({
        host: 'cache.internal',
        port: 6380,
        username: 'monitor',
        password: 'rotated-password',
        tls: true,
        authMode: 'certificate',
        tlsConfig: { source: 'file', trustedPaths: true, certPath: '/etc/tls/client.crt', keyPath: '/etc/tls/client.key', passphrase: 'pw' },
      });
      const persisted = storage.saveConnection.mock.calls.at(-1)![0];
      expect(persisted.id).toBe(ENV_DEFAULT_ID);
      expect(persisted.tls).toBe(true);
      expect(persisted.tlsConfig?.trustedPaths).toBe(true);
      expect(persisted.tlsConfig?.secretsEncrypted).toBe(true);
      expect(enc.decrypt(persisted.tlsConfig!.passphrase!)).toBe('pw');
      expect(enc.decrypt(persisted.password!)).toBe('rotated-password');
    });

    it('never writes a null password after a failed decrypt: the environment supplies it', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ password: 'not-ciphertext', passwordEncrypted: true, tlsConfig: encryptedTls() }),
      ]);
      Object.assign(database, {
        password: 'env-password',
        tls: true,
        tlsConfig: { source: 'inline', cert: ROTATED_CERT, key: PRIVATE_KEY },
      });

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config?.password).toBe('env-password');
      expect(config?.credentialStatus).toBe('valid');
      const persisted = storage.saveConnection.mock.calls.at(-1)![0];
      expect(persisted.password).toBeTruthy();
      expect(enc.decrypt(persisted.password!)).toBe('env-password');
    });

    it('clears persisted material when the environment no longer provides any', async () => {
      storage.getConnections.mockResolvedValue([envDefault({ tlsConfig: encryptedTls(), authMode: 'certificate' })]);
      database.tls = true;

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config?.tlsConfig).toBeUndefined();
      expect(config?.authMode).toBeUndefined();
      expect(storage.saveConnection).toHaveBeenCalled();
    });

    it('does not rewrite the record when nothing changed, whatever the stored key order', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ tlsConfig: { secretsEncrypted: true, passphrase: enc.encrypt('pw'), key: enc.encrypt(PRIVATE_KEY), cert: CERT, source: 'inline' } }),
      ]);
      database.tls = true;
      database.tlsConfig = { source: 'inline', cert: CERT, key: PRIVATE_KEY, passphrase: 'pw' };

      await registry.onModuleInit();

      expect(registry.getConfig(ENV_DEFAULT_ID)?.tlsConfig?.cert).toBe(CERT);
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });

    it('propagates the TLS settings to nodes auto-registered from the default', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ tlsConfig: encryptedTls() }),
        saved({
          id: 'child',
          name: 'Default · 10.0.0.2:6379',
          host: '10.0.0.2',
          isDefault: false,
          tlsConfig: encryptedTls(),
          membership: { seedId: ENV_DEFAULT_ID, nodeId: 'n2', origin: 'auto', source: 'cluster' },
        }),
      ]);
      database.tls = true;
      database.tlsConfig = { source: 'inline', cert: ROTATED_CERT, key: PRIVATE_KEY };
      database.authMode = 'certificate';

      await registry.onModuleInit();

      const child = registry.getConfig('child');
      expect(child?.tlsConfig?.cert).toBe(ROTATED_CERT);
      expect(child?.authMode).toBe('certificate');
      expect(child?.host).toBe('10.0.0.2');
      expect(storage.saveConnection.mock.calls.some(([c]) => c.id === 'child' && c.tlsConfig?.cert === ROTATED_CERT)).toBe(true);
    });

    it('rotates the credentials of nodes auto-registered from the default, but not of adopted ones', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ username: 'default', password: 'old-password' }),
        saved({
          id: 'auto-child',
          name: 'Default · 10.0.0.2:6379',
          host: '10.0.0.2',
          isDefault: false,
          tls: false,
          username: 'default',
          password: 'old-password',
          membership: { seedId: ENV_DEFAULT_ID, nodeId: 'n2', origin: 'auto', source: 'cluster' },
        }),
        saved({
          id: 'adopted-child',
          name: 'My own node',
          host: '10.0.0.3',
          isDefault: false,
          tls: false,
          username: 'own-user',
          password: 'own-password',
          membership: { seedId: ENV_DEFAULT_ID, nodeId: 'n3', origin: 'adopted', source: 'cluster' },
        }),
      ]);
      Object.assign(database, { username: 'monitor', password: 'rotated-password' });

      await registry.onModuleInit();

      expect(registry.getConfig('auto-child')).toMatchObject({ username: 'monitor', password: 'rotated-password', host: '10.0.0.2' });
      // The adapter opened at startup was built from the rotated credentials, not the stored copy.
      const AdapterMock = jest.requireMock('../../database/adapters/unified.adapter').UnifiedDatabaseAdapter as jest.Mock;
      const childAdapterOptions = AdapterMock.mock.calls.filter(([o]) => o.connectionId === 'auto-child').at(-1)?.[0];
      expect(childAdapterOptions).toMatchObject({ username: 'monitor', password: 'rotated-password' });
      // The stored children held plaintext passwords, so boot first re-encrypts them; the
      // last write for the auto child must carry the rotated credential.
      const persistedChild = storage.saveConnection.mock.calls.filter(([c]) => c.id === 'auto-child').at(-1)?.[0];
      expect(persistedChild).toBeDefined();
      expect(enc.decrypt(persistedChild!.password!)).toBe('rotated-password');
      expect(registry.getConfig('adopted-child')).toMatchObject({ username: 'own-user', password: 'own-password' });
      // The adopted child is only re-encrypted, never overlaid with the environment.
      const persistedAdopted = storage.saveConnection.mock.calls.filter(([c]) => c.id === 'adopted-child').at(-1)?.[0];
      expect(persistedAdopted?.username).toBe('own-user');
      expect(enc.decrypt(persistedAdopted!.password!)).toBe('own-password');
    });

    it('never nulls an auto-registered child ciphertext after a failed decrypt: the environment supplies the password', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ tlsConfig: encryptedTls() }),
        saved({
          id: 'child',
          name: 'Default · 10.0.0.2:6379',
          host: '10.0.0.2',
          isDefault: false,
          password: 'not-ciphertext',
          passwordEncrypted: true,
          tlsConfig: encryptedTls(),
          membership: { seedId: ENV_DEFAULT_ID, nodeId: 'n2', origin: 'auto', source: 'cluster' },
        }),
      ]);
      Object.assign(database, { password: 'env-password', tls: true, tlsConfig: { source: 'inline', cert: ROTATED_CERT, key: PRIVATE_KEY } });

      await registry.onModuleInit();

      const child = registry.getConfig('child');
      expect(child?.password).toBe('env-password');
      expect(child?.credentialStatus).toBe('valid');
      const persisted = storage.saveConnection.mock.calls.find(([c]) => c.id === 'child')?.[0];
      expect(persisted?.password).toBeTruthy();
      expect(enc.decrypt(persisted!.password!)).toBe('env-password');
    });

    it('uses env credentials in memory but persists nothing when ENCRYPTION_KEY is missing at boot', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({ password: enc.encrypt('stored-password'), passwordEncrypted: true, tlsConfig: encryptedTls() }),
        saved({
          id: 'child',
          name: 'Default · 10.0.0.2:6379',
          host: '10.0.0.2',
          isDefault: false,
          password: enc.encrypt('stored-password'),
          passwordEncrypted: true,
          membership: { seedId: ENV_DEFAULT_ID, nodeId: 'n2', origin: 'auto', source: 'cluster' },
        }),
      ]);
      Object.assign(database, { password: 'env-password', tls: true, tlsConfig: { source: 'inline', cert: CERT, key: PRIVATE_KEY, passphrase: 'pw' } });
      delete process.env.ENCRYPTION_KEY;
      try {
        registry = await buildRegistry();
        await registry.onModuleInit();
      } finally {
        process.env.ENCRYPTION_KEY = KEY;
        resetEncryptionService();
      }

      // In memory the environment wins, so the pod still connects...
      expect(registry.getConfig(ENV_DEFAULT_ID)).toMatchObject({ password: 'env-password', credentialStatus: 'valid' });
      expect(registry.getConfig('child')).toMatchObject({ password: 'env-password', credentialStatus: 'valid' });
      // ...but nothing is written: a plaintext password or passphrase must never replace the encrypted record.
      expect(storage.saveConnection).not.toHaveBeenCalled();
      expect(storage.updateConnection).not.toHaveBeenCalled();
    });

    it('keeps nodes discovered from such a seed, and a learned SSH host key, in memory only', async () => {
      storage.getConnections.mockResolvedValue([
        envDefault({
          password: enc.encrypt('stored-password'),
          passwordEncrypted: true,
          // Tunnelled with no pinned host key: connecting learns one (trust on first use).
          sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'ops', authMethod: 'password', password: enc.encrypt('ssh-pw'), secretsEncrypted: true },
        }),
      ]);
      database.password = 'env-password';
      delete process.env.ENCRYPTION_KEY;
      try {
        registry = await buildRegistry();
        await registry.onModuleInit();
        // Topology discovery adds a node under the env default.
        const childId = await registry.addManagedChild(ENV_DEFAULT_ID, { host: '10.0.0.9', port: 6379, nodeId: 'n9', source: 'cluster' });

        expect(registry.getConfig(ENV_DEFAULT_ID)?.sshTunnel?.hostKeyFingerprint).toBe('SHA256:learned-on-first-use');
        expect(registry.getConfig(childId)).toMatchObject({ host: '10.0.0.9', password: 'env-password' });
        expect(registry.list().some((c) => c.id === childId)).toBe(true);
      } finally {
        process.env.ENCRYPTION_KEY = KEY;
        resetEncryptionService();
      }
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });

    it('re-encrypts rows that hold plaintext secrets once a cipher is present', async () => {
      storage.getConnections.mockResolvedValue([
        saved({ password: 'plain-password', passwordEncrypted: false, tlsConfig: { source: 'inline', cert: CERT, key: PRIVATE_KEY, passphrase: 'pw', secretsEncrypted: false } }),
      ]);

      await registry.onModuleInit();

      expect(registry.getConfig('c1')).toMatchObject({ password: 'plain-password', credentialStatus: 'valid' });
      const persisted = storage.saveConnection.mock.calls.find(([c]) => c.id === 'c1')?.[0];
      expect(persisted).toBeDefined();
      expect(persisted!.passwordEncrypted).toBe(true);
      expect(enc.decrypt(persisted!.password!)).toBe('plain-password');
      expect(persisted!.tlsConfig?.secretsEncrypted).toBe(true);
      expect(enc.decrypt(persisted!.tlsConfig!.key!)).toBe(PRIVATE_KEY);
      expect(enc.decrypt(persisted!.tlsConfig!.passphrase!)).toBe('pw');
    });

    it('does not re-encrypt a row whose SSH tunnel secrets failed to decrypt (the ciphertext is kept)', async () => {
      // Mixed row: plaintext password, tunnel encrypted under a key that no longer matches.
      const foreign = new EnvelopeEncryptionService('a-different-encryption-key-entirely');
      const sshTunnel: DatabaseConnectionConfig['sshTunnel'] = {
        enabled: true,
        host: 'bastion.internal',
        port: 22,
        username: 'ops',
        authMethod: 'privateKey',
        privateKey: foreign.encrypt(PRIVATE_KEY),
        passphrase: foreign.encrypt('pw'),
        secretsEncrypted: true,
      };
      storage.getConnections.mockResolvedValue([saved({ password: 'plain-password', passwordEncrypted: false, sshTunnel })]);

      await registry.onModuleInit();

      const config = registry.getConfig('c1');
      expect(config?.credentialStatus).toBe('decryption_failed');
      expect(config?.credentialError).toContain('SSH tunnel');
      expect(config?.sshTunnel?.privateKey).toBeUndefined();
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });

    it('does not treat an encrypted-flagged tunnel without secret fields as a failed decrypt', async () => {
      // encryptSshTunnel flags every tunnel, including one that only names a key file.
      const sshTunnel: DatabaseConnectionConfig['sshTunnel'] = {
        enabled: true,
        host: 'bastion.internal',
        port: 22,
        username: 'ops',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: '/etc/betterdb/bastion.pem',
        secretsEncrypted: true,
      };
      storage.getConnections.mockResolvedValue([saved({ password: enc.encrypt('db-password'), passwordEncrypted: true, sshTunnel })]);

      await registry.onModuleInit();

      expect(registry.getConfig('c1')).toMatchObject({ password: 'db-password', credentialStatus: 'valid' });
    });

    it('does not touch plaintext rows while no cipher is available', async () => {
      storage.getConnections.mockResolvedValue([saved({ password: 'plain-password', passwordEncrypted: false })]);
      delete process.env.ENCRYPTION_KEY;
      try {
        registry = await buildRegistry();
        await registry.onModuleInit();
      } finally {
        process.env.ENCRYPTION_KEY = KEY;
        resetEncryptionService();
      }
      expect(registry.getConfig('c1')?.password).toBe('plain-password');
      expect(storage.saveConnection).not.toHaveBeenCalled();
    });

    it('rebuilds the default after a failed decrypt even when DB_PASSWORD is empty', async () => {
      storage.getConnections.mockResolvedValue([envDefault({ password: 'not-ciphertext', passwordEncrypted: true })]);
      database.password = '';

      await registry.onModuleInit();

      const config = registry.getConfig(ENV_DEFAULT_ID);
      expect(config?.credentialStatus).toBe('valid');
      expect(config?.password ?? '').toBe('');
      const persisted = storage.saveConnection.mock.calls.at(-1)![0];
      expect(persisted.id).toBe(ENV_DEFAULT_ID);
      expect(persisted.passwordEncrypted ?? false).toBe(false);
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
