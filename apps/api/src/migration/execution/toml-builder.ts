import type { DatabaseConnectionConfig, RedisShakeOptions, SyncReaderOptions } from '@betterdb/shared';

/**
 * Options for the RedisShake TOML builders. Passed as a single object rather than
 * positional flags so that the several booleans (`sourceIsCluster`,
 * `targetIsCluster`, `excludeFunctions`) can't be silently transposed at a call
 * site — each is named and each is optional with a safe default.
 */
export interface RedisShakeTomlOptions {
  sourceIsCluster: boolean;
  targetIsCluster?: boolean;
  excludeFunctions?: boolean;
  rsOptions?: RedisShakeOptions;
  /** sync_reader only; ignored by the scan_reader builder. */
  syncReaderOptions?: SyncReaderOptions;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function escapeTomlString(value: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Value contains disallowed control characters`);
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function validatePort(port: unknown): number {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return n;
}

function validateHost(host: string): string {
  if (!host || host.length > 253) {
    throw new Error('Invalid host: empty or too long');
  }
  if (/[\s"\\]/.test(host)) {
    throw new Error('Invalid host: contains whitespace, quotes, or backslashes');
  }
  return host;
}

/**
 * When source and target are different engines (e.g. Valkey -> Redis), server-side
 * function libraries must not be replicated: they use engine-specific globals (such
 * as Valkey's `server`) and fail to load on the other fork, aborting the migration.
 * Blocking the FUNCTION command drops FUNCTION LOAD/RESTORE from the stream so the
 * key data still migrates. Returns an empty string (no filter) when not excluding.
 *
 * RedisShake (4.6.x) matches `block_command` case-sensitively against the uppercased,
 * container-expanded command name — `FUNCTION` is expanded to `<CMD>-<SUBCMD>`, so the
 * RDB restore path emits `FUNCTION-LOAD` / `FUNCTION-RESTORE`. A bare lowercase
 * `"function"` matches nothing and silently forwards the library, so the entries must
 * be the fully-qualified upper-case forms.
 */
function buildFilterSection(excludeFunctions: boolean): string {
  if (excludeFunctions === false) {
    return '';
  }
  return `[filter]
block_command = ["FUNCTION-LOAD", "FUNCTION-RESTORE", "FUNCTION-DELETE", "FUNCTION-FLUSH"]

`;
}

function formatAddress(host: string, port: number): string {
  // Bare IPv6 addresses must be wrapped in brackets for Go's net.Dial
  // e.g. "::1" → "[::1]:6379"
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

export function buildScanReaderToml(
  source: DatabaseConnectionConfig,
  target: DatabaseConnectionConfig,
  opts: RedisShakeTomlOptions,
): string {
  const sourceIsCluster = opts.sourceIsCluster;
  const targetIsCluster = opts.targetIsCluster ?? false;
  const rsOptions = opts.rsOptions ?? {};
  const excludeFunctions = opts.excludeFunctions ?? false;

  const srcHost = validateHost(source.host);
  const srcPort = validatePort(source.port);
  const tgtHost = validateHost(target.host);
  const tgtPort = validatePort(target.port);

  const srcUsername = (!source.username || source.username === 'default') ? '' : source.username;
  const srcPassword = source.password ?? '';
  const tgtUsername = (!target.username || target.username === 'default') ? '' : target.username;
  const tgtPassword = target.password ?? '';

  let toml = `[scan_reader]
address = "${escapeTomlString(formatAddress(srcHost, srcPort))}"
username = "${escapeTomlString(srcUsername)}"
password = "${escapeTomlString(srcPassword)}"
tls = ${source.tls ? 'true' : 'false'}
`;

  if (sourceIsCluster) {
    toml += `cluster = true\n`;
  }

  // cluster = true inside [redis_writer] makes RedisShake create a RedisClusterWriter
  // that resolves the full cluster topology and routes each command to the correct node.
  // Without it the standalone writer gets MOVED replies and exits with code 1.
  toml += `
[redis_writer]
cluster = ${targetIsCluster ? 'true' : 'false'}
address = "${escapeTomlString(formatAddress(tgtHost, tgtPort))}"
username = "${escapeTomlString(tgtUsername)}"
password = "${escapeTomlString(tgtPassword)}"
tls = ${target.tls ? 'true' : 'false'}

${buildFilterSection(excludeFunctions)}[advanced]
log_level = "info"
pipeline_count_limit = 256
try_diskless = ${rsOptions.tryDiskless ? 'true' : 'false'}
`;

  return toml;
}

export function buildSyncReaderToml(
  source: DatabaseConnectionConfig,
  target: DatabaseConnectionConfig,
  opts: RedisShakeTomlOptions,
): string {
  const sourceIsCluster = opts.sourceIsCluster;
  const options = opts.syncReaderOptions ?? {};
  const targetIsCluster = opts.targetIsCluster ?? false;
  const rsOptions = opts.rsOptions ?? {};
  const excludeFunctions = opts.excludeFunctions ?? false;

  const srcHost = validateHost(source.host);
  const srcPort = validatePort(source.port);
  const tgtHost = validateHost(target.host);
  const tgtPort = validatePort(target.port);

  const srcUsername = (!source.username || source.username === 'default') ? '' : source.username;
  const srcPassword = source.password ?? '';
  const tgtUsername = (!target.username || target.username === 'default') ? '' : target.username;
  const tgtPassword = target.password ?? '';

  const preferReplica = options.preferReplica === true;

  // Note: sync_reader emits `cluster = ...` always (unlike scan_reader where it's conditional).
  // RedisShake auto-discovers cluster masters and runs PSYNC against each when cluster = true.
  const toml = `[sync_reader]
cluster = ${sourceIsCluster ? 'true' : 'false'}
address = "${escapeTomlString(formatAddress(srcHost, srcPort))}"
username = "${escapeTomlString(srcUsername)}"
password = "${escapeTomlString(srcPassword)}"
tls = ${source.tls ? 'true' : 'false'}
sync_rdb = true
sync_aof = true
prefer_replica = ${preferReplica ? 'true' : 'false'}

[redis_writer]
cluster = ${targetIsCluster ? 'true' : 'false'}
address = "${escapeTomlString(formatAddress(tgtHost, tgtPort))}"
username = "${escapeTomlString(tgtUsername)}"
password = "${escapeTomlString(tgtPassword)}"
tls = ${target.tls ? 'true' : 'false'}

${buildFilterSection(excludeFunctions)}[advanced]
log_level = "info"
pipeline_count_limit = 256
try_diskless = ${rsOptions.tryDiskless ? 'true' : 'false'}
`;

  return toml;
}
