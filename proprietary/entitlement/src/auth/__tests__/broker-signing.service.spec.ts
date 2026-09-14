import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { BROKER_TOKEN_ISSUER, BROKER_TOKEN_TYPE } from '@betterdb/shared';
import { BrokerSigningService } from '../broker-signing.service';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const STATE = 'a'.repeat(43);
const INPUT = {
  email: 'Owner@Example.com',
  name: 'Owner',
  avatarUrl: 'https://avatars.example.com/u/1',
  provider: 'github' as const,
  providerId: 'gh-1',
  aud: 'http://10.0.0.5:3001',
  state: STATE,
};

describe('BrokerSigningService', () => {
  const original = {
    key: process.env.BROKER_SIGNING_PRIVATE_KEY,
    kid: process.env.BROKER_SIGNING_KID,
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.BROKER_SIGNING_PRIVATE_KEY = original.key;
    process.env.BROKER_SIGNING_KID = original.kid;
    if (original.key === undefined) {
      delete process.env.BROKER_SIGNING_PRIVATE_KEY;
    }
    if (original.kid === undefined) {
      delete process.env.BROKER_SIGNING_KID;
    }
    vi.restoreAllMocks();
  });

  function configured(): BrokerSigningService {
    process.env.BROKER_SIGNING_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
    process.env.BROKER_SIGNING_KID = 'brk-test';
    return new BrokerSigningService();
  }

  it('signs a 5-minute RS256 token bound to the origin with the kid header', () => {
    const token = configured().sign(INPUT);
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.kid).toBe('brk-test');
    const claims = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: BROKER_TOKEN_ISSUER,
      audience: INPUT.aud,
    }) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      typ: BROKER_TOKEN_TYPE,
      email: 'owner@example.com',
      name: 'Owner',
      avatarUrl: INPUT.avatarUrl,
      provider: 'github',
      providerId: 'gh-1',
      state: STATE,
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
  });

  it('stamps null for a missing name and avatar', () => {
    const token = configured().sign({ ...INPUT, name: undefined, avatarUrl: undefined });
    const claims = jwt.decode(token) as jwt.JwtPayload;
    expect(claims.name).toBeNull();
    expect(claims.avatarUrl).toBeNull();
  });

  it('refuses with 503 when the key is not configured', () => {
    delete process.env.BROKER_SIGNING_PRIVATE_KEY;
    delete process.env.BROKER_SIGNING_KID;
    const service = new BrokerSigningService();
    expect(service.isConfigured()).toBe(false);
    expect(() => {
      service.sign(INPUT);
    }).toThrow(ServiceUnavailableException);
  });

  it('rejects an aud that is not a bare origin', () => {
    expect(() => {
      configured().sign({ ...INPUT, aud: 'http://10.0.0.5:3001/api' });
    }).toThrow(/origin/);
  });

  it('marks a malformed private key unusable outside production', () => {
    process.env.BROKER_SIGNING_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----';
    process.env.BROKER_SIGNING_KID = 'brk-test';
    const service = new BrokerSigningService();
    expect(service.isConfigured()).toBe(false);
    expect(() => {
      service.sign(INPUT);
    }).toThrow(ServiceUnavailableException);
  });

  it('marks a non-RSA private key unusable outside production', () => {
    const { privateKey: ed25519PrivateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.BROKER_SIGNING_PRIVATE_KEY = ed25519PrivateKey.replace(/\n/g, '\\n');
    process.env.BROKER_SIGNING_KID = 'brk-test';
    const service = new BrokerSigningService();
    expect(service.isConfigured()).toBe(false);
    expect(() => {
      service.sign(INPUT);
    }).toThrow(ServiceUnavailableException);
  });

  it('logs an audit line with a truncated email hash and never the raw email', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    configured().sign(INPUT);

    const expectedHash = createHash('sha256')
      .update(INPUT.email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 12);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0] as [string];
    expect(line).toContain(`aud=${INPUT.aud}`);
    expect(line).toContain(`provider=${INPUT.provider}`);
    expect(line).toContain('kid=brk-test');
    expect(line).toContain(`email=${expectedHash}`);
    expect(line).not.toContain(INPUT.email);
    expect(line).not.toContain(INPUT.email.toLowerCase());
  });
});
