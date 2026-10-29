const SERVERLESS_HOST_PATTERN = /\.serverless\.[a-z0-9-]+\.cache\.amazonaws\.com(\.cn)?\.?$/i;

export function isElastiCacheServerlessHost(host: string): boolean {
  return SERVERLESS_HOST_PATTERN.test(host);
}
