import type { IncomingMessage } from 'http';

export function originsForHost(host: string): string[] {
  if (host === '') {
    return [];
  }
  return [`http://${host}`, `https://${host}`];
}

export function isTrustedUpgradeOrigin(
  request: IncomingMessage,
  trustedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (trustedOrigins.includes(origin)) {
    return true;
  }
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  return originsForHost(host.toLowerCase()).includes(origin);
}
