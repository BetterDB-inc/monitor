export const MISSING_CLOUD_AUTH_MESSAGE =
  'CLOUD_MODE is set but the proprietary cloud auth module is missing';

export function requireCloudAuth<T>(load: () => T): T {
  try {
    return load();
  } catch (cause) {
    throw new Error(MISSING_CLOUD_AUTH_MESSAGE, { cause });
  }
}
