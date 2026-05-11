/**
 * Parse a textual MONITOR line as emitted by `valkey-cli MONITOR` and our
 * iovalkey adapter:
 *
 *   1234567890.123456 [0 127.0.0.1:50000] "GET" "user:42"
 *
 * Output: structured fields for filtering / export. Args preserve original
 * order; `key` is the first arg for keyed commands (heuristic: nearly every
 * keyed command's first arg is the key — MSET / MGET / SUBSCRIBE etc. break
 * this and would need a per-command rule, but the heuristic is good enough
 * for v1's filter UX).
 */
export interface ParsedMonitorLine {
  /** Unix timestamp in milliseconds. */
  ts: number;
  /** Raw timestamp string (e.g. "1234567890.123456") preserved for display fidelity. */
  tsRaw: string;
  db: number;
  addr: string;
  cmd: string;
  args: string[];
  /** First arg for keyed commands; null when there is no first arg or it is not a key. */
  key: string | null;
  /** The original line, useful for debugging or fallback rendering. */
  raw: string;
}

// Non-greedy addr capture so IPv6 `[::1]:port` style addresses (which contain
// `]`) still parse — the trailing `\]\s+"` anchor forces the engine past the
// inner brackets.
const HEADER_RE = /^([0-9.]+)\s+\[(\d+)\s+(.+?)\]\s+(".+)$/;

/**
 * Parse one MONITOR line. Returns `null` for malformed input.
 */
export function parseMonitorLine(line: string): ParsedMonitorLine | null {
  if (!line) return null;
  const m = line.match(HEADER_RE);
  if (!m) return null;

  const tsRaw = m[1];
  const ts = Math.round(parseFloat(tsRaw) * 1000);
  const db = parseInt(m[2], 10);
  const addr = m[3];
  const argTokens = parseQuoted(m[4]);
  if (argTokens.length === 0) return null;

  const cmd = argTokens[0].toUpperCase();
  const args = argTokens.slice(1);
  const key = args.length > 0 ? args[0] : null;

  return { ts, tsRaw, db, addr, cmd, args, key, raw: line };
}

/** Parse a sequence of quoted, backslash-escaped tokens separated by whitespace. */
function parseQuoted(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== '"') return tokens; // malformed; bail with what we have
    i++; // consume opening quote
    let buf = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++; // consume closing quote
        break;
      }
      buf += ch;
      i++;
    }
    tokens.push(buf);
  }
  return tokens;
}

export interface MonitorLineFilters {
  /** Exact verb match, case-insensitive (e.g. "GET", "set"). */
  command?: string;
  /** Substring match on the client address. */
  client?: string;
  /** Glob match (`*` and `?`) on the first arg / key. */
  key?: string;
  /** Inclusive lower bound, ms. */
  afterTs?: number;
  /** Inclusive upper bound, ms. */
  beforeTs?: number;
}

/**
 * Predicate: does the parsed line match all of the supplied filters? An empty
 * filter set matches everything.
 */
export function matchesFilters(line: ParsedMonitorLine, filters: MonitorLineFilters): boolean {
  if (filters.command && line.cmd !== filters.command.toUpperCase()) return false;
  if (filters.client && !line.addr.includes(filters.client)) return false;
  if (filters.key) {
    if (line.key === null) return false;
    const re = globToRegex(filters.key);
    if (!re.test(line.key)) return false;
  }
  if (filters.afterTs !== undefined && line.ts < filters.afterTs) return false;
  if (filters.beforeTs !== undefined && line.ts > filters.beforeTs) return false;
  return true;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Encode a row as a single CSV record per RFC 4180 (commas, quotes, newlines escaped). */
export function lineToCsvRow(line: ParsedMonitorLine): string {
  return [
    csvField(String(line.ts)),
    csvField(line.tsRaw),
    csvField(String(line.db)),
    csvField(line.addr),
    csvField(line.cmd),
    csvField(line.args.join(' ')),
    csvField(line.key ?? ''),
  ].join(',');
}

export const CSV_HEADER = 'ts,ts_raw,db,addr,cmd,args,key';

function csvField(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
