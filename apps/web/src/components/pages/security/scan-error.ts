const CONNECTION_HINT = /\s*Use GET \/connections to list available connections\.?/;
const MISSING_CONNECTION = /^Connection '[^']*' not found/;

export const MISSING_CONNECTION_MESSAGE =
  'This connection no longer exists. Choose another connection to scan.';

export function scanErrorMessage(error: Error | null | undefined, fallback: string): string {
  if (error === null || error === undefined) {
    return fallback;
  }

  const message = error.message.replace(CONNECTION_HINT, '').trim();

  if (message.length === 0) {
    return fallback;
  }

  if (MISSING_CONNECTION.test(message)) {
    return MISSING_CONNECTION_MESSAGE;
  }

  return message;
}
