import type { DatabaseConnectionConfig } from '@betterdb/shared';

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function buildScanReaderToml(
  source: DatabaseConnectionConfig,
  target: DatabaseConnectionConfig,
  sourceIsCluster: boolean,
): string {
  const srcUsername = (!source.username || source.username === 'default') ? '' : source.username;
  const srcPassword = source.password ?? '';
  const tgtUsername = (!target.username || target.username === 'default') ? '' : target.username;
  const tgtPassword = target.password ?? '';

  let toml = `[scan_reader]
address = "${source.host}:${source.port}"
username = "${escapeTomlString(srcUsername)}"
password = "${escapeTomlString(srcPassword)}"
tls = ${source.tls ? 'true' : 'false'}
`;

  if (sourceIsCluster) {
    toml += `cluster = true\n`;
  }

  toml += `
[redis_writer]
address = "${target.host}:${target.port}"
username = "${escapeTomlString(tgtUsername)}"
password = "${escapeTomlString(tgtPassword)}"
tls = ${target.tls ? 'true' : 'false'}

[advanced]
log_level = "info"
`;

  return toml;
}
