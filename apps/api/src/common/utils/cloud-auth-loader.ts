export const MISSING_CLOUD_AUTH_MESSAGE =
  'CLOUD_MODE is set but the proprietary cloud auth module is missing';
export const FAILED_CLOUD_AUTH_MESSAGE =
  'CLOUD_MODE is set but the proprietary cloud auth module failed to load';

function isModuleNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 'MODULE_NOT_FOUND'
  );
}

export function requireCloudAuth<T>(load: () => T): T {
  try {
    return load();
  } catch (cause) {
    const message = isModuleNotFound(cause) ? MISSING_CLOUD_AUTH_MESSAGE : FAILED_CLOUD_AUTH_MESSAGE;
    throw new Error(message, { cause });
  }
}
