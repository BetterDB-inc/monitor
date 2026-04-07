import Valkey from 'iovalkey';
import type { KeyAnalyticsOptions, KeyPatternData } from '@betterdb/shared';
import { extractPattern, checkBlocked, checkSafeMode } from '@betterdb/shared';

export class CommandExecutor {
  private readonly unsafeMode: boolean;

  constructor(
    private readonly client: Valkey,
    options?: { unsafeMode?: boolean },
  ) {
    this.unsafeMode = options?.unsafeMode ?? false;
  }

  isAllowed(cmd: string, args?: string[]): boolean {
    const upperCmd = cmd.toUpperCase();
    const subCommand = args?.[0]?.toUpperCase();

    if (checkBlocked(upperCmd, subCommand)) {
      return false;
    }

    if (!this.unsafeMode && checkSafeMode(upperCmd, subCommand)) {
      return false;
    }

    return true;
  }

  async execute(
    cmd: string,
    args?: string[],
    binaryArgs?: Record<string, Buffer>,
  ): Promise<unknown> {
    const upperCmd = cmd.toUpperCase();

    if (!this.isAllowed(upperCmd, args)) {
      const full = args ? `${upperCmd} ${args.join(' ')}` : upperCmd;
      throw new Error(`Command not allowed: ${full}`);
    }

    if (upperCmd === 'PING') {
      return this.client.ping();
    }

    if (upperCmd === 'INFO') {
      return args && args.length > 0 ? this.client.info(args.join(' ')) : this.client.info();
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

    if (upperCmd === 'HGETFIELD_BUFFER' && args && args.length >= 2) {
      return this.client.hgetBuffer(args[0], args[1]);
    }

    // For FT commands, join command with subcommand using dot notation
    if (upperCmd === 'FT' && args && args.length > 0) {
      const ftCmd = `FT.${args[0].toUpperCase()}`;
      const ftArgs: (string | Buffer)[] = [...args.slice(1)];
      if (binaryArgs) {
        for (let i = 0; i < ftArgs.length; i++) {
          const key = ftArgs[i];
          if (typeof key === 'string' && key in binaryArgs) {
            ftArgs[i] = binaryArgs[key];
          }
        }
      }
      return this.client.call(ftCmd, ...(ftArgs as [string, ...(string | Buffer)[]]));
    }

    // For all other commands, use call()
    const callArgs: (string | Buffer)[] = args ? [upperCmd, ...args] : [upperCmd];
    if (binaryArgs) {
      for (let i = 1; i < callArgs.length; i++) {
        const key = callArgs[i];
        if (typeof key === 'string' && key in binaryArgs) {
          callArgs[i] = binaryArgs[key];
        }
      }
    }
    return this.client.call(...(callArgs as [string, ...(string | Buffer)[]]));
  }

  private async executeCollectKeyAnalytics(optionsJson: string): Promise<string> {
    const options: KeyAnalyticsOptions = JSON.parse(optionsJson);
    const dbSize = await this.client.dbsize();

    if (dbSize === 0) {
      return JSON.stringify({ dbSize: 0, scanned: 0, patterns: [] });
    }

    const patternsMap = new Map<string, KeyPatternData>();
    const keyDetails: Array<{
      keyName: string;
      freqScore: number | null;
      idleSeconds: number | null;
      memoryBytes: number | null;
      ttl: number | null;
    }> = [];
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

          const mem =
            memResult && !memResult[0] && memResult[1] != null ? (memResult[1] as number) : null;
          if (mem !== null) {
            stats.totalMemory += mem;
            if (mem > stats.maxMemory) stats.maxMemory = mem;
          }

          const idle =
            idleResult && !idleResult[0] && idleResult[1] != null
              ? (idleResult[1] as number)
              : null;
          if (idle !== null) {
            stats.totalIdleTime += idle;
          }

          const freq =
            freqResult && !freqResult[0] && freqResult[1] != null
              ? (freqResult[1] as number)
              : null;
          if (freq !== null) {
            stats.accessFrequencies.push(freq);
          }

          const ttl = ttlResult?.[1] as number;
          if (ttl > 0) {
            stats.withTtl++;
            stats.ttlValues.push(ttl);
          } else {
            stats.withoutTtl++;
          }

          patternsMap.set(pattern, stats);

          keyDetails.push({
            keyName: key,
            freqScore: freq,
            idleSeconds: idle,
            memoryBytes: mem,
            ttl: ttl ?? null,
          });
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
      keyDetails,
    });
  }
}
