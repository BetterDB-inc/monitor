export type EngineType = 'valkey' | 'redis';

/**
 * Whether server-side function libraries must be excluded from a migration
 * between these two engines.
 *
 * Function libraries register against an engine-specific global: Valkey
 * libraries use `server`, which Redis does not expose, so a Valkey library
 * fails to load on Redis and aborts the migration. Redis libraries use `redis`,
 * which Valkey still exposes (Valkey is a Redis 7.2 fork), so Redis libraries
 * load fine on Valkey. Functions therefore only need excluding when migrating
 * Valkey -> Redis; every other direction (same engine, or Redis -> Valkey)
 * carries them over safely.
 *
 * Single source of truth shared by the compatibility report (which warns the
 * user) and the executor (which writes the RedisShake filter), so the two can
 * never describe different behaviour.
 */
export function shouldExcludeFunctions(sourceDbType: EngineType, targetDbType: EngineType): boolean {
  return sourceDbType === 'valkey' && targetDbType === 'redis';
}
