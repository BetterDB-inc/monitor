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
  '/v1/external/metrics',
  '/version',
];

const READ_ONLY_PUBLIC_PREFIXES = ['/mcp/'];

// Public paths where a caller's session/bearer is still resolved when sent,
// so the handler can tell a signed-in user from an anonymous probe.
const ACTOR_OPTIONAL_PREFIXES = ['/mcp/', '/health'];

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

export function normalizePath(rawPath: string): string {
  const queryIndex = rawPath.indexOf('?');
  const path = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  return stripApiPrefix(path);
}

export function isActorOptionalPath(rawPath: string): boolean {
  return matchesAnyPrefix(normalizePath(rawPath), ACTOR_OPTIONAL_PREFIXES);
}

export function isPublicPath(rawPath: string, method: string): boolean {
  const path = normalizePath(rawPath);
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
