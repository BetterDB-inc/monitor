export interface ParsedConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  dbIndex: number;
  tls: boolean;
}

export type ParseConnectionUrlResult =
  | { ok: true; value: ParsedConnection }
  | { ok: false; error: string };

const TLS_SCHEMES = new Set(['rediss', 'valkeys']);
const PLAIN_SCHEMES = new Set(['redis', 'valkey']);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Returns true when the input looks like a full connection URL rather than a
 * bare hostname - used to decide whether a pasted value should be expanded
 * into the individual form fields.
 */
export function looksLikeConnectionUrl(input: string): boolean {
  const s = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.includes('@');
}

/**
 * Parses a Valkey/Redis connection URL (or bare host[:port]) into the fields
 * the connection form and API expect.
 *
 * Accepted forms:
 *   redis://user:pass@host:6379/0
 *   rediss://default:token@my-db.upstash.io:6379   (TLS)
 *   valkey://host:6379, valkeys://host:6379
 *   user:pass@host:6380
 *   host:6379, host
 */
export function parseConnectionUrl(input: string): ParseConnectionUrlResult {
  const raw = input.trim();

  if (!raw) {
    return { ok: false, error: 'Enter a connection URL, e.g. rediss://default:password@your-host:6379' };
  }

  if (/^https?:\/\//i.test(raw)) {
    return {
      ok: false,
      error:
        'That looks like an HTTP(S) URL. REST endpoints (like Upstash\'s UPSTASH_REDIS_REST_URL) won\'t work - use the TCP endpoint instead, e.g. rediss://default:password@your-host:6379',
    };
  }

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  let tls = false;
  let normalized: string;

  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (TLS_SCHEMES.has(scheme)) {
      tls = true;
    } else if (!PLAIN_SCHEMES.has(scheme)) {
      return {
        ok: false,
        error: `Unsupported scheme "${scheme}://". Use redis://, rediss://, valkey://, or valkeys://`,
      };
    }
    // Normalize to a fixed scheme so URL parsing behaves consistently.
    normalized = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'redis://');
  } else {
    if (/\s/.test(raw)) {
      return { ok: false, error: 'Connection URLs cannot contain spaces' };
    }
    normalized = `redis://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { ok: false, error: 'Could not parse that as a connection URL. Expected something like rediss://user:password@host:6379' };
  }

  let host = url.hostname;
  // ioredis expects bare IPv6 addresses without brackets.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (!host) {
    return { ok: false, error: 'The URL is missing a host' };
  }

  let port = 6379;
  if (url.port) {
    port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `Invalid port "${url.port}"` };
    }
  }

  let dbIndex = 0;
  const path = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (path) {
    if (!/^\d+$/.test(path)) {
      return { ok: false, error: `Invalid database index "/${path}" - expected a number, e.g. redis://host:6379/0` };
    }
    dbIndex = Number(path);
    if (dbIndex > 15) {
      return { ok: false, error: `Database index ${dbIndex} is out of range (0-15)` };
    }
  }

  const username = safeDecode(url.username);
  const password = safeDecode(url.password);

  return {
    ok: true,
    value: {
      name: host.slice(0, 100),
      host,
      port,
      username: username === 'default' ? '' : username,
      password,
      dbIndex,
      tls,
    },
  };
}
