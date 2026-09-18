import {
  isMetricsEndpointEnabled,
  matchesBearerToken,
  resolveMetricsAccess,
} from './metrics-access';

const base = {
  enabled: undefined as unknown,
  token: undefined as string | undefined,
  cloudMode: false,
  authorization: undefined as string | undefined,
};

describe('isMetricsEndpointEnabled', () => {
  it('defaults to enabled', () => {
    expect(isMetricsEndpointEnabled(undefined)).toBe(true);
  });

  it('is disabled only by an explicit false', () => {
    expect(isMetricsEndpointEnabled('false')).toBe(false);
    expect(isMetricsEndpointEnabled(' false ')).toBe(false);
    expect(isMetricsEndpointEnabled(false)).toBe(false);
    expect(isMetricsEndpointEnabled('true')).toBe(true);
    expect(isMetricsEndpointEnabled('0')).toBe(true);
  });
});

describe('matchesBearerToken', () => {
  it('accepts the exact header', () => {
    expect(matchesBearerToken('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects a missing, short, long or wrong header', () => {
    expect(matchesBearerToken(undefined, 's3cret')).toBe(false);
    expect(matchesBearerToken('Bearer s3cre', 's3cret')).toBe(false);
    expect(matchesBearerToken('Bearer s3cretx', 's3cret')).toBe(false);
    expect(matchesBearerToken('bearer s3cret', 's3cret')).toBe(false);
    expect(matchesBearerToken('s3cret', 's3cret')).toBe(false);
  });

  it('does not throw on length mismatch', () => {
    expect(() => matchesBearerToken('Bearer short', 'a-much-longer-token')).not.toThrow();
  });
});

describe('resolveMetricsAccess', () => {
  it('allows an unconfigured self-hosted deployment', () => {
    expect(resolveMetricsAccess(base)).toBe('allow');
  });

  it('reports disabled before anything else', () => {
    expect(resolveMetricsAccess({ ...base, enabled: 'false', cloudMode: true })).toBe('disabled');
    expect(
      resolveMetricsAccess({
        enabled: 'false',
        token: 's3cret',
        cloudMode: false,
        authorization: 'Bearer s3cret',
      }),
    ).toBe('disabled');
  });

  it('fails closed in cloud mode without a token', () => {
    expect(resolveMetricsAccess({ ...base, cloudMode: true })).toBe('unauthorized');
  });

  it('requires the token once one is configured', () => {
    expect(resolveMetricsAccess({ ...base, token: 's3cret' })).toBe('unauthorized');
    expect(resolveMetricsAccess({ ...base, token: 's3cret', authorization: 'Bearer nope' })).toBe(
      'unauthorized',
    );
    expect(resolveMetricsAccess({ ...base, token: 's3cret', authorization: 'Bearer s3cret' })).toBe(
      'allow',
    );
  });

  it('treats a blank token as unset', () => {
    expect(resolveMetricsAccess({ ...base, token: '   ' })).toBe('allow');
    expect(resolveMetricsAccess({ ...base, token: '   ', cloudMode: true })).toBe('unauthorized');
  });
});
