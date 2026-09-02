const PUBLIC_PREFIXES = [
  '/auth/',
  '/invite/',
  '/system/',
  '/health',
  '/docs',
  '/telemetry/',
  '/mcp/',
  '/prometheus',
  '/ingest/',
  '/v1/traces',
  '/version',
];

export function stripApiPrefix(path: string): string {
  if (path.startsWith('/api/')) {
    return path.slice(4);
  }
  return path;
}

export function isPublicPath(rawPath: string): boolean {
  const path = stripApiPrefix(rawPath.split('?')[0]);
  return PUBLIC_PREFIXES.some((prefix) => {
    return path.startsWith(prefix);
  });
}
