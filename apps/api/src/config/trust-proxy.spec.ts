import { Logger } from '@nestjs/common';
import { resolveTrustProxy, trustsProxyHeaders } from './trust-proxy';

describe('resolveTrustProxy', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  it('refuses a hop count, which Fastify cannot enforce against the connecting address', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '2' })).toBe(false);
    expect(trustsProxyHeaders({ TRUST_PROXY: '2' })).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GHSA-3m5p-2c4r-xxw2'));
  });

  it('passes an address list through to Fastify', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8,127.0.0.1' })).toBe('10.0.0.0/8,127.0.0.1');
    expect(trustsProxyHeaders({ TRUST_PROXY: '10.0.0.0/8,127.0.0.1' })).toBe(true);
  });

  it('treats a zero or negative number as untrusted', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '-1' })).toBe(false);
  });
});
