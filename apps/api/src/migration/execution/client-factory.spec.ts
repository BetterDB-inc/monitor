import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTargetClient, nodeClientAuthOptions } from './client-factory';
import { generateTlsPair } from '../../../test/helpers/tls-fixtures';

const CERT = '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----';

describe('nodeClientAuthOptions', () => {
  it('carries the client certificate and applies SNI for a hostname node', () => {
    const out = nodeClientAuthOptions({ username: 'u', password: 'p', tls: true, tlsConfig: { cert: CERT, key: KEY } }, 'node-1.internal');
    expect(out.username).toBe('u');
    expect(out.tls).toMatchObject({ cert: CERT, key: KEY, servername: 'node-1.internal' });
  });

  it('verifies against the announced hostname when a node is dialled by IP', () => {
    const out = nodeClientAuthOptions({ tls: true }, '10.0.0.5', 'node-1.internal');
    expect(out.tls?.servername).toBe('node-1.internal');
    expect(typeof out.tls?.checkServerIdentity).toBe('function');
  });

  it('sends no credentials in certificate mode', () => {
    const out = nodeClientAuthOptions({ username: 'default', password: '', tls: true, authMode: 'certificate', tlsConfig: { cert: CERT, key: KEY } }, 'h');
    expect(out.username).toBeUndefined();
    expect(out.password).toBeUndefined();
  });

  it('omits identity options when no host is given (Cluster redisOptions)', () => {
    const out = nodeClientAuthOptions({ tls: true, tlsConfig: { ca: 'CA' } });
    expect(out.tls).toEqual({ ca: 'CA' });
  });

  it('has no tls object when TLS is off', () => {
    expect(nodeClientAuthOptions({ tls: false, tlsConfig: { ca: 'CA' } }, 'h').tls).toBeUndefined();
  });
});

describe('createTargetClient (cluster) TLS refresh', () => {
  it('hooks every node the pool adds so a rotated file is re-read before that node reconnects', () => {
    const pairA = generateTlsPair('a');
    const pairB = generateTlsPair('b');
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rotation-'));
    const certPath = path.join(certDir, 'client.crt');
    const keyPath = path.join(certDir, 'client.key');
    fs.writeFileSync(certPath, pairA.cert);
    fs.writeFileSync(keyPath, pairA.key);
    const cluster = createTargetClient(
      { id: 't', name: 'T', host: 'target.internal', port: 6379, tls: true, tlsConfig: { source: 'file', trustedPaths: true, certPath, keyPath }, createdAt: 1 },
      'test',
      true,
    ) as unknown as { emit(event: string, ...args: unknown[]): boolean; disconnect(): void };
    try {
      const handlers: Record<string, () => void> = {};
      const node = { options: { host: '10.0.0.1', port: 6379, tls: { cert: pairA.cert, key: pairA.key } as { cert?: Buffer | string } }, on: jest.fn((event: string, handler: () => void) => { handlers[event] = handler; }) };
      cluster.emit('+node', node);
      expect(handlers['reconnecting']).toBeDefined();

      fs.writeFileSync(certPath, pairB.cert);
      fs.writeFileSync(keyPath, pairB.key);
      handlers['reconnecting']();
      expect(node.options.tls.cert?.toString()).toBe(pairB.cert);
    } finally {
      cluster.disconnect();
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('installs nothing for inline material', () => {
    const cluster = createTargetClient({ id: 't', name: 'T', host: 'target.internal', port: 6379, tls: true, tlsConfig: { ca: 'CA' }, createdAt: 1 }, 'test', true) as unknown as { emit(event: string, ...args: unknown[]): boolean; disconnect(): void };
    try {
      const on = jest.fn();
      cluster.emit('+node', { options: { host: '10.0.0.1', port: 6379 }, on });
      expect(on).not.toHaveBeenCalled();
    } finally {
      cluster.disconnect();
    }
  });
});
