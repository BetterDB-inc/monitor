// Introspection and cluster-management commands, as lower-case latencystats
// names. BetterDB, the operator and cluster clients issue them all the time, so
// they easily pass the latency-regression volume gate, but their latency tracks
// cluster size and host load rather than the application's data path. The list
// mirrors the read-only monitoring ACL in docs/minimum-acl.md plus common
// cluster-client commands. A `|*` suffix matches every subcommand.
export const ADMIN_COMMANDS: readonly string[] = [
  'info',
  'ping',
  'select',
  'hello',
  'auth',
  'role',
  'dbsize',
  'lastsave',
  'time',
  'client|*',
  'config|get',
  'slowlog|*',
  'commandlog|*',
  'latency|*',
  'memory|stats',
  'memory|doctor',
  'acl|whoami',
  'acl|log',
  'command|*',
  'module|list',
  'cluster|info',
  'cluster|nodes',
  'cluster|shards',
  'cluster|slots',
  'cluster|slot-stats',
  'cluster|myid',
  'cluster|getslotmigrations',
  'cluster|links',
  'readonly',
  'readwrite',
];

/**
 * True when `command` (a latencystats name such as `hget` or `client|list`) is
 * in `patterns`. Matching is exact and case-insensitive; `cmd|*` matches every
 * `cmd|<sub>` but neither `cmd` alone nor `cmdx`.
 */
export function matchesCommandPattern(command: string, patterns: Iterable<string>): boolean {
  const name = command.toLowerCase();
  for (const raw of patterns) {
    const pattern = raw.toLowerCase();
    if (pattern.endsWith('|*')) {
      const prefix = pattern.slice(0, -1);
      if (name.length > prefix.length && name.startsWith(prefix)) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

export function isAdminCommand(command: string): boolean {
  return matchesCommandPattern(command, ADMIN_COMMANDS);
}
