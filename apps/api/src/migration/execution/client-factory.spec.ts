import { nodeClientAuthOptions } from './client-factory';

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
