import type { IncomingMessage } from 'http';

const SAME_HOST_SCHEMES = ['http:', 'https:'];

function serializedOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function originsForHost(host: string): string[] {
  if (host === '') {
    return [];
  }
  return SAME_HOST_SCHEMES.map((scheme) => serializedOrigin(`${scheme}//${host}`)).filter(
    (origin): origin is string => origin !== null,
  );
}

export function isTrustedUpgradeOrigin(
  request: IncomingMessage,
  trustedOrigins: readonly string[],
): boolean {
  const header = request.headers.origin;
  if (header === undefined) {
    return true;
  }
  const origin = serializedOrigin(header);
  if (origin === null) {
    return false;
  }
  if (trustedOrigins.some((trusted) => serializedOrigin(trusted) === origin)) {
    return true;
  }
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  return originsForHost(host).includes(origin);
}
