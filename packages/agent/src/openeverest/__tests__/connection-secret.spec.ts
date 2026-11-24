import { parseConnectionSecret } from '../connection-secret';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function secret(data: Record<string, string>) {
  return { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) };
}

const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

describe('parseConnectionSecret', () => {
  it('reads a plain-text (TLS off) provider-valkey secret', () => {
    const creds = parseConnectionSecret(secret({
      type: 'valkey',
      provider: 'valkey',
      host: 'valkey-orders-primary.db.svc.cluster.local',
      port: '6379',
      username: 'default',
      password: 's3cret',
      uri: 'redis://default:s3cret@valkey-orders-primary.db.svc.cluster.local:6379',
    }));

    expect(creds).toEqual({
      host: 'valkey-orders-primary.db.svc.cluster.local',
      port: 6379,
      username: 'default',
      password: 's3cret',
      tls: null,
      type: 'valkey',
    });
  });

  it('reads the CA when ssl=true, without a client certificate', () => {
    const creds = parseConnectionSecret(secret({
      host: 'valkey-orders.db.svc.cluster.local',
      port: '6379',
      username: 'default',
      password: 'p',
      uri: 'rediss://default:p@valkey-orders.db.svc.cluster.local:6379',
      ssl: 'true',
      'ca.crt': CA,
    }));

    expect(creds.tls).toEqual({ ca: CA });
  });

  it('reads the client certificate and key when the server accepts them', () => {
    const creds = parseConnectionSecret(secret({
      host: 'h',
      port: '6379',
      password: 'p',
      ssl: 'true',
      'ca.crt': CA,
      'tls.crt': CERT,
      'tls.key': KEY,
    }));

    expect(creds.tls).toEqual({ ca: CA, cert: CERT, key: KEY });
    expect(creds.username).toBe('default');
  });

  it('falls back to the uri scheme when ssl is absent', () => {
    expect(parseConnectionSecret(secret({ host: 'h', password: 'p', uri: 'rediss://x', 'ca.crt': CA })).tls).toEqual({ ca: CA });
    expect(parseConnectionSecret(secret({ host: 'h', password: 'p', uri: 'redis://x' })).tls).toBeNull();
  });

  it('accepts stringData as written by a test or a hand-made secret', () => {
    const creds = parseConnectionSecret({ stringData: { host: 'h', port: '7000', password: 'p' } });
    expect(creds.port).toBe(7000);
  });

  it('refuses TLS without a CA, since nothing could be verified', () => {
    expect(() => parseConnectionSecret(secret({ host: 'h', password: 'p', ssl: 'true' }))).toThrow(/ca\.crt/);
  });

  it('refuses half a client certificate', () => {
    expect(() => parseConnectionSecret(secret({ host: 'h', ssl: 'true', 'ca.crt': CA, 'tls.crt': CERT }))).toThrow(/client certificate/);
  });

  it('reports a secret the provider has not filled in yet', () => {
    expect(() => parseConnectionSecret({ data: {} })).toThrow(/no host yet/);
    expect(() => parseConnectionSecret(secret({ host: 'h', port: 'abc' }))).toThrow(/invalid port/);
  });
});
