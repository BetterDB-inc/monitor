import { execSync } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import Valkey from 'iovalkey';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '../src/config/config.module';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectionRegistry } from '../src/connections/connection-registry.service';
import { UnifiedDatabaseAdapter } from '../src/database/adapters/unified.adapter';
import { TLS_CERT_DIR_ENV } from '../src/database/adapters/tls-material';

/**
 * Mutual TLS E2E.
 *
 * Runs BetterDB's real connection path against a Valkey 9.1 that requires a
 * client certificate (`tls-auth-clients yes`) and maps the certificate CN to an
 * ACL user (`tls-auth-clients-user CN`). Proves four things the unit tests
 * cannot: the user-supplied certificate is what the server sees, a private CA
 * verifies the server, certificate-only auth really lands on the mapped ACL
 * user (and password mode really overrides it), and ACL WHOAMI reports it.
 *
 * Requires Docker and openssl. Skipped unless RUN_MTLS_TESTS=true.
 * Run via:  pnpm test:mtls
 */

const RUN = process.env.RUN_MTLS_TESTS === 'true';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(PROJECT_ROOT, 'docker-compose.mtls-e2e.yml');
const COMPOSE_PROJECT = 'mtls-e2e';
const CERT_SCRIPT = join(PROJECT_ROOT, 'scripts', 'mtls-e2e-certs.sh');
const CERT_DIR = join(__dirname, '.mtls-certs');

const HOST = 'localhost';
const PORT = 6395;
const MAPPED_USER = 'monitor-mtls';
const KEY_PASSPHRASE = 'e2e-passphrase';

function compose(cmd: string): string {
  return execSync(`docker compose -p ${COMPOSE_PROJECT} -f "${COMPOSE_FILE}" ${cmd}`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function pem(name: string): string {
  return fs.readFileSync(join(CERT_DIR, name), 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    const probe = new Valkey({
      host: HOST,
      port: PORT,
      tls: { ca: pem('ca.crt'), cert: pem('client.crt'), key: pem('client.key'), servername: HOST },
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    probe.on('error', () => undefined);
    try {
      await probe.connect();
      if ((await probe.ping()) === 'PONG') {
        probe.disconnect();
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    probe.disconnect();
    await sleep(1_000);
  }
  throw new Error(`mTLS Valkey did not become ready: ${lastError}`);
}

function adapter(overrides: Partial<ConstructorParameters<typeof UnifiedDatabaseAdapter>[0]> = {}) {
  return new UnifiedDatabaseAdapter({
    host: HOST,
    port: PORT,
    username: 'default',
    password: '',
    tls: true,
    ...overrides,
  });
}

(RUN ? describe : describe.skip)('Mutual TLS E2E (tls-auth-clients yes, tls-auth-clients-user CN)', () => {
  beforeAll(async () => {
    execSync(`"${CERT_SCRIPT}" "${CERT_DIR}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      compose('down --remove-orphans --volumes');
    } catch {
      // Nothing running yet.
    }
    compose('up -d');
    await waitForServer();
  }, 240_000);

  afterAll(() => {
    try {
      compose('down --remove-orphans --volumes');
    } catch {
      // Best effort.
    }
  }, 120_000);

  it('is rejected by the server when no client certificate is presented (the gap this feature closes)', async () => {
    const plainTls = new Valkey({
      host: HOST,
      port: PORT,
      tls: { ca: pem('ca.crt'), servername: HOST },
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    plainTls.on('error', () => undefined);
    await expect(
      plainTls.connect().then(() => plainTls.ping()),
    ).rejects.toThrow();
    plainTls.disconnect();
  });

  it('presents the user-supplied certificate and lands on the CN-mapped ACL user with no AUTH sent', async () => {
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: { ca: pem('ca.crt'), cert: pem('client.crt'), key: pem('client.key') },
    });
    try {
      await db.connect();
      expect(db.isConnected()).toBe(true);
      expect(db.getAuthenticatedUser()).toBe(MAPPED_USER);
      expect(await db.call('ACL', ['WHOAMI'])).toBe(MAPPED_USER);
      // A normal monitoring command works as that user.
      const info = await db.getInfo(['server']);
      expect(info).toHaveProperty('server');
    } finally {
      await db.disconnect();
    }
  });

  it('accepts a passphrase-protected private key', async () => {
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: {
        ca: pem('ca.crt'),
        cert: pem('client.crt'),
        key: pem('client-enc.key'),
        passphrase: KEY_PASSPHRASE,
      },
    });
    try {
      await db.connect();
      expect(db.getAuthenticatedUser()).toBe(MAPPED_USER);
    } finally {
      await db.disconnect();
    }
  });

  it('rejects a passphrase-protected key without its passphrase', async () => {
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: { ca: pem('ca.crt'), cert: pem('client.crt'), key: pem('client-enc.key') },
    });
    await expect(db.connect()).rejects.toThrow();
    await db.disconnect().catch(() => undefined);
  });

  it('reads file-sourced material from BETTERDB_TLS_CERT_DIR', async () => {
    const previous = process.env[TLS_CERT_DIR_ENV];
    process.env[TLS_CERT_DIR_ENV] = CERT_DIR;
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: { source: 'file', caPath: 'ca.crt', certPath: 'client.crt', keyPath: 'client.key' },
    });
    try {
      await db.connect();
      expect(db.getAuthenticatedUser()).toBe(MAPPED_USER);
    } finally {
      await db.disconnect();
      if (previous === undefined) delete process.env[TLS_CERT_DIR_ENV];
      else process.env[TLS_CERT_DIR_ENV] = previous;
    }
  });

  it('falls back to the default user when the CN maps to no ACL user, and WHOAMI makes that visible', async () => {
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: { ca: pem('ca.crt'), cert: pem('stranger.crt'), key: pem('stranger.key') },
    });
    try {
      await db.connect();
      expect(db.getAuthenticatedUser()).toBe('default');
    } finally {
      await db.disconnect();
    }
  });

  it('in password mode the AUTH that BetterDB sends overrides the certificate identity (why certificate mode exists)', async () => {
    const db = adapter({
      authMode: 'password',
      username: 'default',
      password: '',
      tlsConfig: { ca: pem('ca.crt'), cert: pem('client.crt'), key: pem('client.key') },
    });
    try {
      await db.connect();
      // Same certificate as the mapped test above, but AUTH default "" re-authenticates
      // the session as `default`.
      expect(db.getAuthenticatedUser()).toBe('default');
    } finally {
      await db.disconnect();
    }
  });

  it('fails server verification without the private CA (verification is never weakened)', async () => {
    const db = adapter({
      authMode: 'certificate',
      tlsConfig: { cert: pem('client.crt'), key: pem('client.key') },
    });
    // iovalkey rejects connect() with a generic "Connection is closed"; the TLS
    // verification failure itself is emitted on the client's error event.
    const socketError = new Promise<string>((resolve) =>
      db.getClient().once('error', (err: Error) => resolve(err.message)),
    );
    await expect(db.connect()).rejects.toThrow();
    await expect(socketError).resolves.toMatch(/self[- ]signed|unable to verify|unable to get local issuer/i);
    await db.disconnect().catch(() => undefined);
  });

  describe('through the connection registry (DTO shape)', () => {
    let appContext: INestApplicationContext;
    let registry: ConnectionRegistry;

    beforeAll(async () => {
      process.env.BETTERDB_TELEMETRY = 'false';
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule, ConnectionsModule],
      }).compile();
      appContext = await moduleRef.init();
      registry = appContext.get(ConnectionRegistry);
    }, 60_000);

    afterAll(async () => {
      await appContext?.close();
    });

    const request = () => ({
      name: 'mtls',
      host: HOST,
      port: PORT,
      tls: true,
      authMode: 'certificate' as const,
      tlsConfig: { ca: pem('ca.crt'), cert: pem('client.crt'), key: pem('client.key') },
    });

    it('testConnection reports the mapped ACL user', async () => {
      const result = await registry.testConnection(request());
      expect(result).toMatchObject({ success: true, authenticatedUser: MAPPED_USER });
      expect(result.capabilities?.dbType).toBe('valkey');
    });

    it('testConnection rejects certificate mode without a certificate before dialing', async () => {
      const result = await registry.testConnection({ ...request(), tlsConfig: undefined });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/client certificate and private key/);
    });

    it('addConnection persists the material redacted and exposes the live ACL user', async () => {
      const id = await registry.addConnection(request());
      try {
        const status = registry.list().find((c) => c.id === id);
        expect(status).toMatchObject({
          isConnected: true,
          authMode: 'certificate',
          authenticatedUser: MAPPED_USER,
          tlsConfig: { source: 'inline', hasCa: true, hasClientCert: true },
        });
        // No PEM content leaks through the status surface.
        expect(JSON.stringify(status)).not.toContain('BEGIN');
      } finally {
        await registry.removeConnection(id);
      }
    });
  });
});
