export class InfoParser {
  static parse(infoString: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = infoString.split('\r\n');
    let currentSection = 'default';

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith('#')) {
        if (trimmedLine.startsWith('# ')) {
          currentSection = trimmedLine.substring(2).toLowerCase();
          result[currentSection] = {};
        }
        continue;
      }

      const colonIndex = trimmedLine.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmedLine.substring(0, colonIndex);
      const value = trimmedLine.substring(colonIndex + 1);

      if (typeof result[currentSection] === 'object' && result[currentSection] !== null) {
        (result[currentSection] as Record<string, string>)[key] = value;
      }
    }

    return result;
  }

  static getVersion(info: Record<string, unknown>): string | null {
    const server = info.server as Record<string, string> | undefined;
    if (!server) return null;

    return server.valkey_version || server.redis_version || null;
  }

  static isValkey(info: Record<string, unknown>): boolean {
    const server = info.server as Record<string, string> | undefined;
    if (!server) return false;

    return 'valkey_version' in server;
  }

  /**
   * Parses a "k=v<sep>k=v<sep>…" line into a string map.
   *
   * Used across INFO sections where a single line carries multiple fields —
   * e.g. `cmdstat_*` lines (`calls=100,usec=500,usec_per_call=5.00,…`),
   * `keyspace.db*` (`keys=123,expires=5,avg_ttl=0`), and CLIENT LIST rows
   * (`id=1 addr=... name=...`, space-separated).
   *
   * Unlike `pair.split('=')`, this preserves `=` inside values by splitting
   * on the first `=` only. Callers are responsible for coercing to number
   * or other types as needed.
   */
  static parseKvLine(line: string, separator: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!line) {
      return result;
    }

    for (const pair of line.split(separator)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      if (!key) continue;
      result[key] = pair.slice(eq + 1).trim();
    }
    return result;
  }
}
