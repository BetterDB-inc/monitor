const NEGATIVE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Single source of truth for the deployment mode: any non-empty CLOUD_MODE
 * value outside the negative set is cloud. The negative set matches the
 * BETTERDB_TELEMETRY parser so the two flags read the same spellings the
 * same way. Parts of the codebase used to disagree
 * (`if (process.env.CLOUD_MODE)` vs `=== 'true'`), splitting a deployment
 * into half-cloud behavior for values like CLOUD_MODE=1.
 *
 * The web app deliberately does NOT parse a build-time flag: its cloud
 * signal is the runtime cloudUser threaded from App.tsx.
 */
export function isCloudModeValue(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && !NEGATIVE_VALUES.has(v);
}

export function isCloudMode(): boolean {
  return isCloudModeValue(process.env.CLOUD_MODE);
}
