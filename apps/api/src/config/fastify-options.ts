import { resolveTrustProxy } from './trust-proxy';

export const MAX_PARAM_LENGTH = 8192;

export const fastifyAdapterOptions = (env: NodeJS.ProcessEnv) => ({
  trustProxy: resolveTrustProxy(env),
  maxParamLength: MAX_PARAM_LENGTH,
});
