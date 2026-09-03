/**
 * Single source of truth for the deployment mode. Parts of the codebase used
 * to disagree (`if (process.env.CLOUD_MODE)` vs `=== 'true'`), so a value
 * like `CLOUD_MODE=1` loaded the cloud retention cron while the pollers took
 * the self-hosted branch. Any non-empty value except 'false'/'0' is cloud.
 */
export function isCloudMode(): boolean {
  const value = process.env.CLOUD_MODE?.trim().toLowerCase();
  return !!value && value !== 'false' && value !== '0';
}
