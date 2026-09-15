import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const BROKER_NONCE_COOKIE = 'betterdb.broker_nonce';
const NONCE_BYTES = 32;

export interface BrokerNonce {
  value: string;
  hash: string;
}

export interface BrokerNonceCookieOptions {
  path: string;
  secure: boolean;
  maxAgeSeconds: number;
}

export function hashBrokerNonce(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createBrokerNonce(): BrokerNonce {
  const value = randomBytes(NONCE_BYTES).toString('base64url');
  return { value, hash: hashBrokerNonce(value) };
}

export function brokerNonceMatches(value: string | null, expectedHash: string | null): boolean {
  if (value === null || expectedHash === null) {
    return false;
  }
  const actual = Buffer.from(hashBrokerNonce(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function readBrokerNonce(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) {
    return null;
  }
  const prefix = `${BROKER_NONCE_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix) === false) {
      continue;
    }
    const value = trimmed.slice(prefix.length);
    if (value.length === 0) {
      return null;
    }
    return value;
  }
  return null;
}

export function serializeBrokerNonceCookie(
  value: string,
  options: BrokerNonceCookieOptions,
): string {
  const parts = [
    `${BROKER_NONCE_COOKIE}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure === true) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
