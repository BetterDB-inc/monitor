"""Canonical bounds for a proposed or runtime-overridden TTL, in seconds.

Mirrored from packages/shared/src/utils/cache-proposals.ts, which this package
cannot import: @betterdb/shared is a private TypeScript package and this is a
separately published Python wheel.
scripts/check-ttl-constants.mjs fails CI if this drifts from the canonical.
"""

TTL_SECONDS_MIN = 10
TTL_SECONDS_MAX = 86400
