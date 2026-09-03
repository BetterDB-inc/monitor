/**
 * Canonical parse of a CLOUD_MODE-style flag value, shared by the API
 * (process.env.CLOUD_MODE) and the web app (import.meta.env.VITE_CLOUD_MODE)
 * so the two layers can never split-brain on values like "1": any non-empty
 * value except 'false'/'0' means cloud.
 */
export function isCloudModeValue(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && v !== 'false' && v !== '0';
}
