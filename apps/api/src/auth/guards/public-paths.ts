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

function matchesPrefix(path: string, prefix: string): boolean {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (path === base) {
    return true;
  }
  return path.startsWith(`${base}/`);
}

export function isPublicPath(rawPath: string): boolean {
  const path = stripApiPrefix(rawPath.split('?')[0]);
  return PUBLIC_PREFIXES.some((prefix) => {
    return matchesPrefix(path, prefix);
  });
}
