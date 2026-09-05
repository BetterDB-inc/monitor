export type TrustProxySetting = boolean | number | string;

export function resolveTrustProxy(env: NodeJS.ProcessEnv): TrustProxySetting {
  const raw = env.TRUST_PROXY === undefined ? '' : env.TRUST_PROXY.trim();
  if (raw === '' || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  const hops = Number(raw);
  if (Number.isNaN(hops) === false) {
    if (Number.isInteger(hops) === true && hops > 0) {
      return hops;
    }
    return false;
  }
  return raw;
}

export function trustsProxyHeaders(env: NodeJS.ProcessEnv): boolean {
  return resolveTrustProxy(env) !== false;
}
