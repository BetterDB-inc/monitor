import type { DatabaseConnectionConfig } from '@betterdb/shared';

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
  // Allow hostname, IPv4, or bracketed IPv6
  if (/[\s"\\]/.test(host)) {
    throw new Error('Invalid host: contains whitespace, quotes, or backslashes');
  }
  return host;
}

export function buildScanReaderToml(
  source: DatabaseConnectionConfig,
  target: DatabaseConnectionConfig,
  sourceIsCluster: boolean,
): string {
  const srcHost = validateHost(source.host);
  const srcPort = validatePort(source.port);
  const tgtHost = validateHost(target.host);
  const tgtPort = validatePort(target.port);

  const srcUsername = (!source.username || source.username === 'default') ? '' : source.username;
  const srcPassword = source.password ?? '';
  const tgtUsername = (!target.username || target.username === 'default') ? '' : target.username;
  const tgtPassword = target.password ?? '';

  let toml = `[scan_reader]
address = "${escapeTomlString(srcHost)}:${srcPort}"
username = "${escapeTomlString(srcUsername)}"
password = "${escapeTomlString(srcPassword)}"
tls = ${source.tls ? 'true' : 'false'}
`;

  if (sourceIsCluster) {
    toml += `cluster = true\n`;
  }

  toml += `
[redis_writer]
address = "${escapeTomlString(tgtHost)}:${tgtPort}"
username = "${escapeTomlString(tgtUsername)}"
password = "${escapeTomlString(tgtPassword)}"
tls = ${target.tls ? 'true' : 'false'}

[advanced]
log_level = "info"
`;

  return toml;
}
