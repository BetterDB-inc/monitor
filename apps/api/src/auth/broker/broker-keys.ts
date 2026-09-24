import { BROKER_SIGNING_PUBLIC_KEYS } from '@betterdb/shared';

export const DEFAULT_BROKER_KEY_ID = 'brk-override';

export function resolveBrokerKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const override = (env.AUTH_BROKER_PUBLIC_KEY ?? '').trim();
  if (override.length === 0) {
    return { ...BROKER_SIGNING_PUBLIC_KEYS };
  }
  const kid = (env.AUTH_BROKER_KEY_ID ?? '').trim();
  return { [kid.length > 0 ? kid : DEFAULT_BROKER_KEY_ID]: override.replace(/\\n/g, '\n') };
}
