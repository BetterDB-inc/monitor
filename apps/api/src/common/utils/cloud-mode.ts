/**
 * Single source of truth for the deployment mode: any non-empty CLOUD_MODE
 * value except 'false'/'0' is cloud. Parts of the codebase used to disagree
 * (`if (process.env.CLOUD_MODE)` vs `=== 'true'`), splitting a deployment
 * into half-cloud behavior for values like CLOUD_MODE=1.
 *
 * The web app deliberately does NOT parse a build-time flag: its cloud
 * signal is the runtime cloudUser threaded from App.tsx.
 */
export function isCloudModeValue(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && v !== 'false' && v !== '0';
}

export function isCloudMode(): boolean {
  return isCloudModeValue(process.env.CLOUD_MODE);
}
