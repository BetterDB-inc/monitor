import { describe, it, expect } from 'vitest';
import { parseConnectionUrl, looksLikeConnectionUrl } from './connectionUrl';

function expectOk(input: string) {
  const result = parseConnectionUrl(input);
  if (!result.ok) throw new Error(`expected ok for "${input}", got error: ${result.error}`);
  return result.value;
}

function expectError(input: string): string {
  const result = parseConnectionUrl(input);
  if (result.ok) throw new Error(`expected error for "${input}", got ${JSON.stringify(result.value)}`);
  return result.error;
}

describe('parseConnectionUrl', () => {
  it('parses a full redis:// URL', () => {
    const value = expectOk('redis://myuser:s3cret@redis.example.com:6380/2');
    expect(value).toEqual({
      name: 'redis.example.com',
      host: 'redis.example.com',
      port: 6380,
      username: 'myuser',
      password: 's3cret',
      dbIndex: 2,
      tls: false,
    });
  });

  it('enables TLS for rediss:// and valkeys://', () => {
    expect(expectOk('rediss://default:token@my-db.upstash.io:6379').tls).toBe(true);
    expect(expectOk('valkeys://host:6379').tls).toBe(true);
    expect(expectOk('valkey://host:6379').tls).toBe(false);
    expect(expectOk('redis://host:6379').tls).toBe(false);
  });

  it('treats the "default" username as empty (form default)', () => {
    const value = expectOk('rediss://default:token@my-db.upstash.io:6379');
    expect(value.username).toBe('');
    expect(value.password).toBe('token');
  });

  it('defaults port to 6379 and dbIndex to 0', () => {
    const value = expectOk('redis://redis.example.com');
    expect(value.port).toBe(6379);
    expect(value.dbIndex).toBe(0);
  });

  it('parses bare host and host:port', () => {
    expect(expectOk('redis.example.com')).toMatchObject({ host: 'redis.example.com', port: 6379 });
    expect(expectOk('redis.example.com:7000')).toMatchObject({ host: 'redis.example.com', port: 7000 });
  });

  it('parses credentials without a scheme', () => {
    const value = expectOk('default:mypassword@farsighted-64576.db.redis.io:11577');
    expect(value).toMatchObject({
      host: 'farsighted-64576.db.redis.io',
      port: 11577,
      username: '',
      password: 'mypassword',
      tls: false,
    });
  });

  it('percent-decodes username and password', () => {
    const value = expectOk('redis://my%40user:p%40ss%2Fword@host:6379');
    expect(value.username).toBe('my@user');
    expect(value.password).toBe('p@ss/word');
  });

  it('strips brackets from IPv6 hosts', () => {
    const value = expectOk('redis://[::1]:6379');
    expect(value.host).toBe('::1');
    expect(value.port).toBe(6379);
  });

  it('ignores a trailing slash', () => {
    expect(expectOk('redis://host:6379/').dbIndex).toBe(0);
  });

  it('truncates derived names to 100 characters', () => {
    const host = `${'a'.repeat(120)}.example.com`;
    expect(expectOk(`redis://${host}:6379`).name).toHaveLength(100);
  });

  it('rejects http(s) URLs with REST guidance', () => {
    const error = expectError('https://us1-example-12345.upstash.io');
    expect(error).toContain('REST');
    expect(error).toContain('rediss://');
  });

  it('rejects unsupported schemes', () => {
    expect(expectError('mysql://host:3306')).toContain('Unsupported scheme');
  });

  it('rejects empty input, spaces, and garbage', () => {
    expect(expectError('')).toBeTruthy();
    expect(expectError('   ')).toBeTruthy();
    expect(expectError('not a url at all')).toContain('spaces');
  });

  it('rejects invalid database indexes', () => {
    expect(expectError('redis://host:6379/abc')).toContain('database index');
    expect(expectError('redis://host:6379/16')).toContain('out of range');
  });

  it('rejects URLs without a host', () => {
    expect(expectError('redis://:password@:6379')).toBeTruthy();
  });
});

describe('looksLikeConnectionUrl', () => {
  it('detects scheme or credential forms', () => {
    expect(looksLikeConnectionUrl('redis://host')).toBe(true);
    expect(looksLikeConnectionUrl('rediss://a:b@host:6379')).toBe(true);
    expect(looksLikeConnectionUrl('user:pass@host')).toBe(true);
  });

  it('rejects bare hostnames', () => {
    expect(looksLikeConnectionUrl('redis.example.com')).toBe(false);
    expect(looksLikeConnectionUrl('localhost')).toBe(false);
  });
});
