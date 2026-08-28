/**
 * Canonical bounds for a proposed or runtime-overridden TTL, in seconds.
 *
 * Mirrored from packages/shared/src/utils/cache-proposals.ts, which this
 * package cannot import: @betterdb/shared is private and is never published,
 * so depending on it would break `npm install @betterdb/semantic-cache`.
 * scripts/check-ttl-constants.mjs fails CI if this drifts from the canonical.
 */
export const TTL_SECONDS_MIN = 10;
export const TTL_SECONDS_MAX = 86400;
