import * as jwt from 'jsonwebtoken';
import {
  BROKER_TOKEN_ISSUER,
  BROKER_TOKEN_TYPE,
  type BrokerTokenClaims,
  isBrokerProvider,
} from '@betterdb/shared';

const MAX_TOKEN_AGE = '10m';

export class BrokerTokenError extends Error {}

function requireString(payload: jwt.JwtPayload, key: string): string {
  const value: unknown = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrokerTokenError(`Broker token is missing ${key}`);
  }
  return value;
}

function optionalString(payload: jwt.JwtPayload, key: string): string | null {
  const value: unknown = payload[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function keyFor(token: string, keys: Record<string, string>): string {
  const decoded = jwt.decode(token, { complete: true });
  if (decoded === null) {
    throw new BrokerTokenError('Broker token is malformed');
  }
  const kid = decoded.header.kid;
  if (typeof kid !== 'string') {
    throw new BrokerTokenError('Broker token has no key id');
  }
  const key = keys[kid];
  if (key === undefined) {
    throw new BrokerTokenError('Broker token key is not trusted');
  }
  return key;
}

export function verifyBrokerToken(token: string, keys: Record<string, string>): BrokerTokenClaims {
  const key = keyFor(token, keys);
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: BROKER_TOKEN_ISSUER,
      maxAge: MAX_TOKEN_AGE,
    });
  } catch {
    throw new BrokerTokenError('Broker token failed verification');
  }
  if (typeof payload === 'string') {
    throw new BrokerTokenError('Broker token payload is not an object');
  }
  if (payload.typ !== BROKER_TOKEN_TYPE) {
    throw new BrokerTokenError('Broker token has the wrong type');
  }
  if (typeof payload.exp !== 'number') {
    throw new BrokerTokenError('Broker token has no expiry');
  }
  const provider: unknown = payload.provider;
  if (isBrokerProvider(provider) === false) {
    throw new BrokerTokenError('Broker token has an unknown provider');
  }
  if (typeof payload.aud !== 'string') {
    throw new BrokerTokenError('Broker token audience must be one origin');
  }
  return {
    typ: BROKER_TOKEN_TYPE,
    email: requireString(payload, 'email').trim().toLowerCase(),
    name: optionalString(payload, 'name'),
    avatarUrl: optionalString(payload, 'avatarUrl'),
    provider,
    providerId: requireString(payload, 'providerId'),
    state: requireString(payload, 'state'),
    aud: payload.aud,
  };
}
