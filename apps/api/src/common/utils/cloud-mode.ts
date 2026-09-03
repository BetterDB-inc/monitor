/**
 * Single source of truth for the deployment mode. Parts of the codebase used
 * to disagree (`if (process.env.CLOUD_MODE)` vs `=== 'true'`), so a value
 * like `CLOUD_MODE=1` loaded the cloud retention cron while the pollers took
 * the self-hosted branch. Any non-empty value except 'false'/'0' is cloud.
 */
import { isCloudModeValue } from '@betterdb/shared';

export { isCloudModeValue };

export function isCloudMode(): boolean {
  return isCloudModeValue(process.env.CLOUD_MODE);
}
