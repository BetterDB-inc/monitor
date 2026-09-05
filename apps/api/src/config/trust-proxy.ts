import { Logger } from '@nestjs/common';

export type TrustProxySetting = boolean | string;

const logger = new Logger('TrustProxy');

const HOP_COUNT_REJECTED =
  'TRUST_PROXY was set to a hop count, which Fastify cannot enforce safely ' +
  '(GHSA-3m5p-2c4r-xxw2: the hop-count form ignores the connecting address, so forwarded ' +
  'headers can be spoofed by anyone who reaches the API directly). Proxy headers stay ' +
  'untrusted. Set TRUST_PROXY to the proxy addresses or CIDRs instead, or to true when the ' +
  'API is only reachable through the proxy.';

export function resolveTrustProxy(env: NodeJS.ProcessEnv): TrustProxySetting {
  const raw = env.TRUST_PROXY === undefined ? '' : env.TRUST_PROXY.trim();
  if (raw === '' || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  if (Number.isNaN(Number(raw)) === false) {
    logger.warn(HOP_COUNT_REJECTED);
    return false;
  }
  return raw;
}

export function trustsProxyHeaders(env: NodeJS.ProcessEnv): boolean {
  return resolveTrustProxy(env) !== false;
}
