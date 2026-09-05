import { resolveTrustProxy, trustsProxyHeaders } from './trust-proxy';

describe('resolveTrustProxy', () => {
  it('does not trust proxy headers by default', () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(trustsProxyHeaders({})).toBe(false);
  });

  it('treats an empty or false value as untrusted', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '  ' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
  });

  it('trusts every hop when set to true', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true);
    expect(trustsProxyHeaders({ TRUST_PROXY: 'true' })).toBe(true);
  });

  it('reads a positive integer as a hop count', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '2' })).toBe(2);
    expect(trustsProxyHeaders({ TRUST_PROXY: '2' })).toBe(true);
  });

  it('passes an address list through to Fastify', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8,127.0.0.1' })).toBe('10.0.0.0/8,127.0.0.1');
    expect(trustsProxyHeaders({ TRUST_PROXY: '10.0.0.0/8,127.0.0.1' })).toBe(true);
  });

  it('treats a zero or negative hop count as untrusted', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '-1' })).toBe(false);
  });
});
