const PUBLIC_PREFIXES = [
  '/auth/',
  '/invite/',
  '/system/workspace',
  '/health',
  '/docs',
  '/telemetry/',
  '/prometheus',
  '/ingest/',
  '/v1/traces',
  '/version',
];

const READ_ONLY_PUBLIC_PREFIXES = ['/mcp/'];

const PUBLIC_WRITE_PATHS = [
  /^\/mcp\/telemetry$/,
  /^\/mcp\/instance\/[^/]+\/memory\/[^/]+\/recall$/,
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

function matchesAnyPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    return matchesPrefix(path, prefix);
  });
}

export function isPublicPath(rawPath: string, method: string): boolean {
  const path = stripApiPrefix(rawPath.split('?')[0]);
  if (matchesAnyPrefix(path, PUBLIC_PREFIXES)) {
    return true;
  }
  if (matchesAnyPrefix(path, READ_ONLY_PUBLIC_PREFIXES) === false) {
    return false;
  }
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return true;
  }
  return PUBLIC_WRITE_PATHS.some((pattern) => {
    return pattern.test(path);
  });
}
