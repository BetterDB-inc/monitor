import {
  SlowLogEntry,
  SlowLogPatternAnalysis,
  SlowLogPatternStats,
  CommandBreakdown,
  KeyPrefixBreakdown,
  ClientBreakdown,
} from '../common/types/metrics.types';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_REGEX = /^\d+$/;
const LONG_ALPHANUMERIC_REGEX = /^[a-zA-Z0-9]{20,}$/;
const MAX_ARG_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const BLOB_PLACEHOLDER = '<blob>';

function isFtCommand(command: string): boolean {
  return command.startsWith('FT.');
}

function sanitizeCommandArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (typeof arg !== 'string') return BLOB_PLACEHOLDER;
    if (arg.length > MAX_ARG_LENGTH) return BLOB_PLACEHOLDER;
    if (arg.includes('\uFFFD')) return BLOB_PLACEHOLDER;
    if (CONTROL_CHAR_REGEX.test(arg)) return BLOB_PLACEHOLDER;
    return arg;
  });
}

export function extractKeyPattern(key: string): string {
  if (!key || key.length === 0) return key;

  const delimiter = key.includes(':')
    ? ':'
    : key.includes('/')
      ? '/'
      : null;

  if (!delimiter) {
    // No delimiter - check if entire key is dynamic
    if (
      NUMERIC_REGEX.test(key) ||
      UUID_REGEX.test(key) ||
      LONG_ALPHANUMERIC_REGEX.test(key)
    ) {
      return '*';
    }
    return key;
  }

  const segments = key.split(delimiter);
  const patternSegments = segments.map((segment) => {
    if (NUMERIC_REGEX.test(segment)) return '*';
    if (UUID_REGEX.test(segment)) return '*';
    if (LONG_ALPHANUMERIC_REGEX.test(segment)) return '*';
    // Short hex strings that look like IDs (e.g., "a1b2c3d4")
    if (/^[0-9a-f]{6,}$/i.test(segment) && segment.length >= 6) return '*';
    return segment;
  });

  return patternSegments.join(delimiter);
}

export function createPatternKey(
  command: string,
  keyPattern: string | null,
): string {
  return keyPattern ? `${command} ${keyPattern}` : command;
}

export function analyzeSlowLogPatterns(
  entries: SlowLogEntry[],
): SlowLogPatternAnalysis {
  if (entries.length === 0) {
    return {
      totalEntries: 0,
      analyzedAt: Date.now(),
      patterns: [],
      byCommand: [],
      byKeyPrefix: [],
      byClient: [],
    };
  }

  const patternMap = new Map<
    string,
    {
      command: string;
      keyPattern: string;
      entries: SlowLogEntry[];
    }
  >();

  const commandMap = new Map<string, SlowLogEntry[]>();
  const prefixMap = new Map<string, SlowLogEntry[]>();
  const clientMap = new Map<string, SlowLogEntry[]>();

  for (const entry of entries) {
    const command = entry.command[0]?.toUpperCase() || 'UNKNOWN';
    const key = entry.command[1] || null;
    const keyPattern = key ? extractKeyPattern(key) : '(no key)';
    const patternKey = createPatternKey(command, keyPattern);

    // Aggregate by full pattern
    if (!patternMap.has(patternKey)) {
      patternMap.set(patternKey, { command, keyPattern, entries: [] });
    }
    patternMap.get(patternKey)!.entries.push(entry);

    // Aggregate by command
    if (!commandMap.has(command)) {
      commandMap.set(command, []);
    }
    commandMap.get(command)!.push(entry);

    // Aggregate by key prefix (first segment before delimiter)
    // FT.* commands use an index name rather than a keyspace key, so
    // aggregating them by prefix yields meaningless results.
    if (key && !isFtCommand(command)) {
      const prefix = key.split(/[:/]/)[0] + ':';
      if (!prefixMap.has(prefix)) {
        prefixMap.set(prefix, []);
      }
      prefixMap.get(prefix)!.push(entry);
    }

    // Aggregate by client
    const clientIdentifier = entry.clientName || entry.clientAddress;
    if (!clientMap.has(clientIdentifier)) {
      clientMap.set(clientIdentifier, []);
    }
    clientMap.get(clientIdentifier)!.push(entry);
  }

  const totalEntries = entries.length;

  // Build pattern stats
  const patterns: SlowLogPatternStats[] = Array.from(patternMap.entries())
    .map(([pattern, data]) => {
      const durations = data.entries.map((e) => e.duration);
      const totalDuration = durations.reduce((a, b) => a + b, 0);

      // Build client breakdown for this pattern
      const clientMap = new Map<string, SlowLogEntry[]>();
      for (const entry of data.entries) {
        const clientIdentifier = entry.clientName || entry.clientAddress;
        if (!clientMap.has(clientIdentifier)) {
          clientMap.set(clientIdentifier, []);
        }
        clientMap.get(clientIdentifier)!.push(entry);
      }

      const clientBreakdown = Array.from(clientMap.entries())
        .map(([clientIdentifier, clientEntries]) => {
          const clientDurations = clientEntries.map((e) => e.duration);
          return {
            clientIdentifier,
            count: clientEntries.length,
            percentage: (clientEntries.length / data.entries.length) * 100,
            avgDuration:
              clientDurations.reduce((a, b) => a + b, 0) / clientEntries.length,
            maxDuration: Math.max(...clientDurations),
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10); // Top 10 clients

      return {
        pattern,
        command: data.command,
        keyPattern: data.keyPattern,
        count: data.entries.length,
        percentage: (data.entries.length / totalEntries) * 100,
        totalDuration,
        avgDuration: totalDuration / data.entries.length,
        maxDuration: Math.max(...durations),
        minDuration: Math.min(...durations),
        examples: data.entries.slice(0, 3).map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          duration: e.duration,
          fullCommand: sanitizeCommandArgs(e.command),
          clientAddress: e.clientAddress,
        })),
        clientBreakdown,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Build command breakdown
  const byCommand: CommandBreakdown[] = Array.from(commandMap.entries())
    .map(([command, cmdEntries]) => ({
      command,
      count: cmdEntries.length,
      percentage: (cmdEntries.length / totalEntries) * 100,
      avgDuration:
        cmdEntries.reduce((a, e) => a + e.duration, 0) / cmdEntries.length,
    }))
    .sort((a, b) => b.count - a.count);

  // Build key prefix breakdown
  const byKeyPrefix: KeyPrefixBreakdown[] = Array.from(prefixMap.entries())
    .map(([prefix, prefixEntries]) => ({
      prefix,
      count: prefixEntries.length,
      percentage: (prefixEntries.length / totalEntries) * 100,
      avgDuration:
        prefixEntries.reduce((a, e) => a + e.duration, 0) /
        prefixEntries.length,
    }))
    .sort((a, b) => b.count - a.count);

  // Build client breakdown
  const byClient: ClientBreakdown[] = Array.from(clientMap.entries())
    .map(([clientIdentifier, clientEntries]) => ({
      clientIdentifier,
      count: clientEntries.length,
      percentage: (clientEntries.length / totalEntries) * 100,
      avgDuration:
        clientEntries.reduce((a, e) => a + e.duration, 0) /
        clientEntries.length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    totalEntries,
    analyzedAt: Date.now(),
    patterns,
    byCommand,
    byKeyPrefix,
    byClient,
  };
}
