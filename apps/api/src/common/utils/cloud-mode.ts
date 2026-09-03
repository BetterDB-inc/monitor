import { isCloudModeValue } from '@betterdb/shared';

/**
 * Deployment-mode check for the API. The value semantics live in
 * `@betterdb/shared` (isCloudModeValue) so the web app parses its flag
 * identically; this wrapper just binds them to process.env.CLOUD_MODE.
 */
export function isCloudMode(): boolean {
  return isCloudModeValue(process.env.CLOUD_MODE);
}
