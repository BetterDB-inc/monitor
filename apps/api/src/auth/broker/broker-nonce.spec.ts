import {
  BROKER_NONCE_COOKIE,
  brokerNonceMatches,
  createBrokerNonce,
  readBrokerNonce,
  serializeBrokerNonceCookie,
} from './broker-nonce';

describe('broker nonce', () => {
  it('matches only the nonce it was created from', () => {
    const nonce = createBrokerNonce();
    const other = createBrokerNonce();
    expect(brokerNonceMatches(nonce.value, nonce.hash)).toBe(true);
    expect(brokerNonceMatches(other.value, nonce.hash)).toBe(false);
  });

  it('never matches a missing nonce or a missing hash', () => {
    const nonce = createBrokerNonce();
    expect(brokerNonceMatches(null, nonce.hash)).toBe(false);
    expect(brokerNonceMatches(nonce.value, null)).toBe(false);
    expect(brokerNonceMatches(nonce.value, 'not-hex')).toBe(false);
  });

  it('reads the nonce out of a cookie header with other cookies', () => {
    const header = `a=1; ${BROKER_NONCE_COOKIE}=abc; better-auth.session_token=x`;
    expect(readBrokerNonce(header)).toBe('abc');
    expect(readBrokerNonce('a=1')).toBeNull();
    expect(readBrokerNonce(`${BROKER_NONCE_COOKIE}=`)).toBeNull();
    expect(readBrokerNonce(undefined)).toBeNull();
  });

  it('serializes an HttpOnly, SameSite=Lax cookie scoped to the auth path', () => {
    expect(
      serializeBrokerNonceCookie('abc', { path: '/api/auth', secure: true, maxAgeSeconds: 600 }),
    ).toBe(
      `${BROKER_NONCE_COOKIE}=abc; Path=/api/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(serializeBrokerNonceCookie('', { path: '/auth', secure: false, maxAgeSeconds: 0 })).toBe(
      `${BROKER_NONCE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });
});
