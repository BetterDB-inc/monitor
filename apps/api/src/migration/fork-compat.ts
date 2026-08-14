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

/**
 * Whether the source holds server-side function libraries.
 *
 * - 'present': `FUNCTION LIST` returned at least one library.
 * - 'absent':  `FUNCTION LIST` returned an empty list, OR the engine doesn't
 *   implement the FUNCTION command at all (Redis < 7.0 replies "unknown command").
 *   Either way there are definitively no function libraries, so a clean older
 *   instance still reports no compatibility issues.
 * - 'unknown': the probe threw for an indeterminate reason (ACL user without
 *   `function|list`, a cluster node that can't route the command, a connection
 *   error, …). We could not determine presence, so callers must NOT treat it as "no
 *   functions" — the executor still writes the filter and would drop libraries that
 *   may well exist, so we err toward warning the user.
 */
export type FunctionPresence = 'present' | 'absent' | 'unknown';

/** Minimal client surface needed to probe functions (satisfied by the iovalkey client). */
export interface FunctionProbeClient {
  call(command: string, ...args: string[]): Promise<unknown>;
}

export async function probeSourceFunctions(client: FunctionProbeClient): Promise<FunctionPresence> {
  try {
    const result = await client.call('FUNCTION', 'LIST');
    return Array.isArray(result) && result.length > 0 ? 'present' : 'absent';
  } catch (err) {
    // "unknown command" means the engine has no FUNCTION feature (Redis < 7.0), so
    // there are provably no function libraries — that's 'absent', not indeterminate.
    // Everything else (permissions, routing, connectivity) stays 'unknown'.
    const message = err instanceof Error ? err.message : String(err);
    if (/unknown command/i.test(message)) {
      return 'absent';
    }
    return 'unknown';
  }
}
