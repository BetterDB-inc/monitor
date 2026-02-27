export type StartupErrorCategory =
  | 'connection_refused'
  | 'port_in_use'
  | 'auth_failed'
  | 'timeout'
  | 'storage_init'
  | 'config_invalid'
  | 'unknown';

export function categorizeError(error: Error): StartupErrorCategory {
  const msg = error.message || '';

  if (/ECONNREFUSED/.test(msg)) return 'connection_refused';
  if (/EADDRINUSE/.test(msg)) return 'port_in_use';
  if (/NOAUTH|WRONGPASS|ERR AUTH/.test(msg)) return 'auth_failed';
  if (/ETIMEDOUT|ECONNRESET|timeout/i.test(msg)) return 'timeout';
  if (/Invalid environment|validation failed|missing required/i.test(msg)) return 'config_invalid';
  if (/storage|sqlite|ENOENT.*\.db/i.test(msg)) return 'storage_init';

  return 'unknown';
}
