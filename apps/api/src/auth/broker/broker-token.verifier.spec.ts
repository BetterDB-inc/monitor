import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { BrokerTokenError, verifyBrokerToken } from './broker-token.verifier';

function keyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const trusted = keyPair();
const stranger = keyPair();
const KEYS = { 'brk-test': trusted.publicKey };
const STATE = 'S'.repeat(43);

interface SignOptions {
  claims?: Record<string, unknown>;
  key?: string;
  kid?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: number;
}

function sign(options: SignOptions = {}): string {
  return jwt.sign(
    {
      typ: 'self-hosted-broker',
      email: 'owner@example.com',
      name: 'Owner',
      avatarUrl: null,
      provider: 'google',
      providerId: 'g-1',
      state: STATE,
      ...options.claims,
    },
    options.key ?? trusted.privateKey,
    {
      algorithm: 'RS256',
      keyid: options.kid ?? 'brk-test',
      issuer: options.issuer ?? 'betterdb-entitlement',
      audience: options.audience ?? 'http://localhost',
      expiresIn: options.expiresIn ?? 300,
    },
  );
}

describe('verifyBrokerToken', () => {
  it('returns the claims of a good token', () => {
    expect(verifyBrokerToken(sign(), KEYS)).toEqual({
      typ: 'self-hosted-broker',
      email: 'owner@example.com',
      name: 'Owner',
      avatarUrl: null,
      provider: 'google',
      providerId: 'g-1',
      state: STATE,
      aud: 'http://localhost',
    });
  });

  it.each([
    ['an unknown kid', sign({ kid: 'brk-other' })],
    ['a foreign signature', sign({ key: stranger.privateKey })],
    ['a wrong issuer', sign({ issuer: 'someone-else' })],
    ['an expired token', sign({ expiresIn: -10 })],
    ['a wrong type', sign({ claims: { typ: 'workspace' } })],
    ['an unknown provider', sign({ claims: { provider: 'gitlab' } })],
    ['a missing email', sign({ claims: { email: '' } })],
    ['a missing state', sign({ claims: { state: undefined } })],
    ['garbage', 'not-a-jwt'],
  ])('rejects %s', (_label, token) => {
    expect(() => {
      verifyBrokerToken(token, KEYS);
    }).toThrow(BrokerTokenError);
  });

  it('rejects when no key is trusted at all', () => {
    expect(() => {
      verifyBrokerToken(sign(), {});
    }).toThrow(BrokerTokenError);
  });
});
