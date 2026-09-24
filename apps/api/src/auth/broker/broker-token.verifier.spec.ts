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
  audience?: string | string[];
  expiresIn?: number;
  header?: Record<string, unknown>;
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
      header: { alg: 'RS256', ...options.header } as jwt.JwtHeader,
    },
  );
}

function failureOf(token: string): BrokerTokenError {
  try {
    verifyBrokerToken(token, KEYS);
  } catch (error) {
    if (error instanceof BrokerTokenError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the token to be rejected');
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
    ['a wrong type', sign({ claims: { typ: 'workspace' } })],
    ['an unknown provider', sign({ claims: { provider: 'gitlab' } })],
    ['a missing email', sign({ claims: { email: '' } })],
    ['a missing state', sign({ claims: { state: undefined } })],
    ['garbage', 'not-a-jwt'],
    ['a __proto__ kid', sign({ kid: '__proto__' })],
    ['a constructor kid', sign({ kid: 'constructor' })],
    ['a numeric kid', sign({ header: { kid: 7 } })],
    ['an array audience', sign({ audience: ['http://localhost', 'http://other.example'] })],
  ])('rejects %s as invalid', (_label, token) => {
    expect(failureOf(token).reason).toBe('invalid');
  });

  it('flags a token past its expiry as expired', () => {
    expect(failureOf(sign({ expiresIn: -10 })).reason).toBe('expired');
  });

  it('flags a token older than the maximum age as expired', () => {
    const issuedLongAgo = Math.floor(Date.now() / 1000) - 11 * 60;
    const token = sign({ claims: { iat: issuedLongAgo }, expiresIn: 3600 });
    expect(failureOf(token).reason).toBe('expired');
  });

  it('never resolves a key inherited from the prototype chain', () => {
    const polluted = Object.create({ inherited: trusted.publicKey }) as Record<string, string>;
    expect(() => {
      verifyBrokerToken(sign({ kid: 'inherited' }), polluted);
    }).toThrow(BrokerTokenError);
  });

  it('rejects when no key is trusted at all', () => {
    expect(() => {
      verifyBrokerToken(sign(), {});
    }).toThrow(BrokerTokenError);
  });
});
