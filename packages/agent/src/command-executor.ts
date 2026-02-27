import Valkey from 'iovalkey';
import type { KeyAnalyticsOptions, KeyPatternData } from '@betterdb/shared';
import { extractPattern } from '@betterdb/shared';

const ALLOWED_COMMANDS: Set<string> = new Set([
  'PING', 'INFO', 'DBSIZE',
  'SLOWLOG', 'COMMANDLOG',
  'LATENCY',
  'CLIENT',
  'ACL',
  'CONFIG',
  'CLUSTER',
  'MEMORY',
  'COMMAND',
  'ROLE',
  'LASTSAVE',
  'COLLECT_KEY_ANALYTICS',
]);

// Subcommands that are explicitly allowed for each command
const ALLOWED_SUBCOMMANDS: Record<string, Set<string>> = {
  CONFIG: new Set(['GET']),
  CLIENT: new Set(['LIST', 'INFO', 'GETNAME']),
  ACL: new Set(['LOG', 'LIST', 'WHOAMI', 'USERS']),
  SLOWLOG: new Set(['GET', 'LEN', 'RESET']),
  COMMANDLOG: new Set(['GET', 'LEN', 'RESET']),
  LATENCY: new Set(['LATEST', 'HISTORY', 'HISTOGRAM', 'RESET', 'DOCTOR']),
  CLUSTER: new Set(['INFO', 'SLOTS', 'SLOT-STATS', 'NODES']),
  MEMORY: new Set(['DOCTOR', 'STATS']),
  COMMAND: new Set(['COUNT', 'DOCS']),
};

export class CommandExecutor {
  constructor(private readonly client: Valkey) {}

  isAllowed(cmd: string, args?: string[]): boolean {
    const upperCmd = cmd.toUpperCase();
    if (!ALLOWED_COMMANDS.has(upperCmd)) {
      return false;
    }

    const allowedSubs = ALLOWED_SUBCOMMANDS[upperCmd];
    if (allowedSubs) {
      if (!args || args.length === 0) {
        return false;
      }
      const subCmd = args[0].toUpperCase();
      return allowedSubs.has(subCmd);
    }

    // Commands without subcommand restrictions
    return true;
  }

  async execute(cmd: string, args?: string[]): Promise<unknown> {
    const upperCmd = cmd.toUpperCase();

    if (!this.isAllowed(upperCmd, args)) {
      const full = args ? `${upperCmd} ${args.join(' ')}` : upperCmd;
      throw new Error(`Command not allowed: ${full}`);
    }

    if (upperCmd === 'PING') {
      return this.client.ping();
    }

    if (upperCmd === 'INFO') {
      return args && args.length > 0
        ? this.client.info(args.join(' '))
        : this.client.info();
    }

    if (upperCmd === 'DBSIZE') {
      return this.client.dbsize();
    }

    if (upperCmd === 'LASTSAVE') {
      return this.client.lastsave();
    }

    if (upperCmd === 'CONFIG' && args) {
      return this.client.config('GET', ...args.slice(1));
    }

    if (upperCmd === 'COLLECT_KEY_ANALYTICS' && args) {
      return this.executeCollectKeyAnalytics(args[0]);
    }

    // For all other commands, use call()
    const callArgs = args ? [upperCmd, ...args] : [upperCmd];
    return this.client.call(...(callArgs as [string, ...string[]]));
  }

  private async executeCollectKeyAnalytics(optionsJson: string): Promise<string> {
    const options: KeyAnalyticsOptions = JSON.parse(optionsJson);
    const dbSize = await this.client.dbsize();

    if (dbSize === 0) {
      return JSON.stringify({ dbSize: 0, scanned: 0, patterns: [] });
    }

    const patternsMap = new Map<string, KeyPatternData>();
    let cursor = '0';
    let scanned = 0;

    do {
      const [newCursor, keys] = await this.client.scan(cursor, 'COUNT', options.scanBatchSize);
      cursor = newCursor;

      for (const key of keys) {
        if (scanned >= options.sampleSize) break;
        scanned++;

        const pattern = extractPattern(key);
        const stats = patternsMap.get(pattern) || {
          pattern,
          count: 0,
          totalMemory: 0,
          maxMemory: 0,
          totalIdleTime: 0,
          withTtl: 0,
          withoutTtl: 0,
          ttlValues: [],
          accessFrequencies: [],
        };

        try {
          const pipeline = this.client.pipeline();
          pipeline.memory('USAGE', key);
          pipeline.object('IDLETIME', key);
          pipeline.object('FREQ', key);
          pipeline.ttl(key);

          const results = (await pipeline.exec()) || [];
          const [memResult, idleResult, freqResult, ttlResult] = results;

          stats.count++;

          if (memResult && memResult[1] !== null) {
            const mem = memResult[1] as number;
            stats.totalMemory += mem;
            if (mem > stats.maxMemory) stats.maxMemory = mem;
          }

          if (idleResult && idleResult[1] !== null) {
            stats.totalIdleTime += idleResult[1] as number;
          }

          if (freqResult && freqResult[1] !== null) {
            stats.accessFrequencies.push(freqResult[1] as number);
          }

          const ttl = ttlResult?.[1] as number;
          if (ttl > 0) {
            stats.withTtl++;
            stats.ttlValues.push(ttl);
          } else {
            stats.withoutTtl++;
          }

          patternsMap.set(pattern, stats);
        } catch {
          // Skip keys that can't be inspected
        }
      }

      if (scanned >= options.sampleSize) break;
    } while (cursor !== '0');

    return JSON.stringify({
      dbSize,
      scanned,
      patterns: Array.from(patternsMap.values()),
    });
  }
}
