export const BROKER_TOKEN_ISSUER = 'betterdb-entitlement';
export const BROKER_TOKEN_TYPE = 'self-hosted-broker';
export const BROKER_SIGN_IN_PATH = '/self-hosted/sign-in';
export const BROKER_PROVIDERS = ['google', 'github'] as const;

export type BrokerProvider = (typeof BROKER_PROVIDERS)[number];

export const BROKER_SIGNING_PUBLIC_KEYS: Record<string, string> = {
  'brk-2026-09': `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoMIq5BpVf/NNyiYMjwoY
ug9NtrR6tpnopzs9QQEq4ze/snrKj9xNDvyBsyIbfXmr1PM1CIkUR3UOaQs3JTx/
qHQk1ZzspFkj9lKJpN9ekUyT5KJKEfEzbS3txq2EUcBNCkIuCQIcRd5peo1URE+0
ZL0rkeneYW4ivVUOPVY/Wcd10TBea7KCft7QyNFvpvMZYC1DK4vOQBaQmrfEgay5
G/j/uBgHUROiOGu9f8/RVWzJwtMK7PeuyG2s3Y4LzXsMGKQtqT0RaL2rnt/bDmbz
2ETBpNXXBak9hghc1myNHyEJeEPGu+0l9pBBJbdDyOAO0Q7NwBcgkwKrlVDcLmxp
jwIDAQAB
-----END PUBLIC KEY-----`,
};

export interface BrokerTokenClaims {
  typ: typeof BROKER_TOKEN_TYPE;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  provider: BrokerProvider;
  providerId: string;
  state: string;
  aud: string;
}

export function isBrokerProvider(value: unknown): value is BrokerProvider {
  if (typeof value !== 'string') {
    return false;
  }
  return (BROKER_PROVIDERS as readonly string[]).includes(value);
}
