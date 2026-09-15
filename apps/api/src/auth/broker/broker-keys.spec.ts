import { BROKER_SIGNING_PUBLIC_KEYS } from '@betterdb/shared';
import { DEFAULT_BROKER_KEY_ID, resolveBrokerKeys } from './broker-keys';

describe('resolveBrokerKeys', () => {
  it('uses the embedded keys by default', () => {
    expect(resolveBrokerKeys({})).toEqual(BROKER_SIGNING_PUBLIC_KEYS);
  });

  it('replaces them with an env key, unescaping \\n', () => {
    const keys = resolveBrokerKeys({ AUTH_BROKER_PUBLIC_KEY: 'line1\\nline2' });
    expect(keys).toEqual({ [DEFAULT_BROKER_KEY_ID]: 'line1\nline2' });
  });

  it('honours AUTH_BROKER_KEY_ID', () => {
    const keys = resolveBrokerKeys({
      AUTH_BROKER_PUBLIC_KEY: 'pem',
      AUTH_BROKER_KEY_ID: 'brk-staging',
    });
    expect(keys).toEqual({ 'brk-staging': 'pem' });
  });

  it('ignores a blank env key', () => {
    expect(resolveBrokerKeys({ AUTH_BROKER_PUBLIC_KEY: '  ' })).toEqual(BROKER_SIGNING_PUBLIC_KEYS);
  });
});
