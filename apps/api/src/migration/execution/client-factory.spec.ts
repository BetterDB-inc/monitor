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
  // iovalkey's pool creates node clients with `retryStrategy: null`, so they
  // never emit `reconnecting`; the refresh has to happen as nodes are added.
  // Drive the real pool so a hand-built fake node cannot hide that.
  type Pool = { findOrCreate(node: { host: string; port: number }): { redis: { options: { tls?: { cert?: Buffer | string }; retryStrategy?: unknown }; listenerCount(event: string): number } } };
  type ClusterLike = { options: { redisOptions?: { tls?: { cert?: Buffer | string } } }; connectionPool: Pool; listenerCount(event: string): number; disconnect(): void };
  const certOf = (holder: { options: { tls?: { cert?: Buffer | string } } }) => holder.options.tls?.cert?.toString();

  it('gives every node the pool adds the material on disk at that moment, and hands it on to later nodes', () => {
    const pairA = generateTlsPair('a');
    const pairB = generateTlsPair('b');
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rotation-'));
    const certPath = path.join(certDir, 'client.crt');
    const keyPath = path.join(certDir, 'client.key');
    fs.writeFileSync(certPath, pairA.cert);
    fs.writeFileSync(keyPath, pairA.key);
    const errors: string[] = [];
    const cluster = createTargetClient(
      { id: 't', name: 'T', host: 'target.internal', port: 6379, tls: true, tlsConfig: { source: 'file', trustedPaths: true, certPath, keyPath }, createdAt: 1 },
      'test',
      true,
      (m) => errors.push(m),
    ) as unknown as ClusterLike;
    try {
      const first = cluster.connectionPool.findOrCreate({ host: '10.0.0.1', port: 6379 }).redis;
      expect(certOf(first)).toBe(pairA.cert);
      // The dead path: a node client never reconnects, so nothing may rely on that event.
      expect(first.options.retryStrategy).toBeNull();
      expect(first.listenerCount('reconnecting')).toBe(0);

      fs.writeFileSync(certPath, pairB.cert);
      fs.writeFileSync(keyPath, pairB.key);
      const second = cluster.connectionPool.findOrCreate({ host: '10.0.0.2', port: 6379 }).redis;
      expect(certOf(second)).toBe(pairB.cert);
      // The pool copies redisOptions into each node it builds, so a node rebuilt
      // later (after a dropped socket) starts from the rotated material too.
      expect(cluster.options.redisOptions?.tls?.cert?.toString()).toBe(pairB.cert);
      expect(errors).toEqual([]);

      // Mid-rotation (certificate replaced before its key): the new node keeps the last good pair.
      const pairC = generateTlsPair('c');
      fs.writeFileSync(certPath, pairC.cert);
      const third = cluster.connectionPool.findOrCreate({ host: '10.0.0.3', port: 6379 }).redis;
      expect(certOf(third)).toBe(pairB.cert);
      expect(cluster.options.redisOptions?.tls?.cert?.toString()).toBe(pairB.cert);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/10\.0\.0\.3:6379.*TLS material is not usable/);
    } finally {
      cluster.disconnect();
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('installs nothing for inline material', () => {
    const cluster = createTargetClient({ id: 't', name: 'T', host: 'target.internal', port: 6379, tls: true, tlsConfig: { ca: 'CA' }, createdAt: 1 }, 'test', true) as unknown as ClusterLike;
    try {
      expect(cluster.listenerCount('+node')).toBe(0);
    } finally {
      cluster.disconnect();
    }
  });
});
