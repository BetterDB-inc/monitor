export const BROKER_TOKEN_ISSUER = 'betterdb-entitlement';
export const BROKER_TOKEN_TYPE = 'self-hosted-broker';
export const BROKER_SIGN_IN_PATH = '/self-hosted/sign-in';
export const BROKER_PROVIDERS = ['google', 'github'] as const;

export type BrokerProvider = (typeof BROKER_PROVIDERS)[number];

export const BROKER_SIGNING_PUBLIC_KEYS: Record<string, string> = {};

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
