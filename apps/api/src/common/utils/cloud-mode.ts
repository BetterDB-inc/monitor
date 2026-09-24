import { isNegativeEnvValue } from './env-bool';

/**
 * Single source of truth for the deployment mode: any non-empty CLOUD_MODE
 * value that isn't an explicit negative is cloud. The negatives come from the
 * shared isNegativeEnvValue() helper that BETTERDB_TELEMETRY also uses, so the
 * two flags read the same spellings the same way. Parts of the codebase used
 * to disagree (`if (process.env.CLOUD_MODE)` vs `=== 'true'`), splitting a
 * deployment into half-cloud behavior for values like CLOUD_MODE=1.
 *
 * The web app deliberately does NOT parse a build-time flag: its cloud
 * signal is the runtime cloudUser threaded from App.tsx.
 */
export function isCloudModeValue(value: string | undefined): boolean {
  const v = value?.trim();
  return !!v && !isNegativeEnvValue(v);
}

export function isCloudMode(): boolean {
  return isCloudModeValue(process.env.CLOUD_MODE);
}
