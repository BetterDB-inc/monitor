import Valkey from 'iovalkey';
import type { KeyAnalyticsOptions, KeyDetail, KeyPatternData } from '@betterdb/shared';
import { extractPattern, checkBlocked, checkSafeMode, pruneKeyDetails, KEY_DETAILS_PRUNE_AT, STALE_KEY_IDLE_SECONDS } from '@betterdb/shared';

// OBJECT IDLETIME is rejected under an LFU maxmemory-policy and OBJECT FREQ
// under any other; both errors name the LFU policy.
function isLfuPolicyMismatch(error: Error | null | undefined): boolean {
  return !!error && /LFU maxmemory policy/i.test(error.message);
}

const SIZE_COMMAND_BY_TYPE = new Map<string, string>([
  ['string', 'STRLEN'],
  ['list', 'LLEN'],
  ['hash', 'HLEN'],
  ['set', 'SCARD'],
  ['zset', 'ZCARD'],
  ['stream', 'XLEN'],
]);

export class CommandExecutor {
  private readonly unsafeMode: boolean;
  // Which OBJECT probe the key scan sends; flips when the server's eviction
  // policy rejects the current one (see isLfuPolicyMismatch).
  private keyScanUsesLfu = false;

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
    // Tag the result with the logical database the agent is connected to
    // (`--valkey-db`), so the cloud attributes the analytics to the right db
    // instead of defaulting everything to db0.
    const db = this.client.options?.db ?? 0;

    if (dbSize === 0) {
      return JSON.stringify({ dbSize: 0, scanned: 0, patterns: [], db });
    }

    const patternsMap = new Map<string, KeyPatternData>();
    let keyDetails: KeyDetail[] = [];
    let cursor = '0';
    let scanned = 0;

    do {
      const [newCursor, scannedKeys] = await this.client.scan(cursor, 'COUNT', options.scanBatchSize);
      cursor = newCursor;
      const keys = options.fullScan
        ? scannedKeys
        : scannedKeys.slice(0, Math.max(0, options.sampleSize - scanned));
      // TYPE first, so each key gets only its own size probe. Probing every type
      // returned WRONGTYPE for the rest, which inflated the server's error_replies.
      const types = await this.readKeyTypes(keys);

      for (const [index, key] of keys.entries()) {
        scanned++;

        const pattern = extractPattern(key);
        const stats = patternsMap.get(pattern) || {
          pattern,
          count: 0,
          totalMemory: 0,
          maxMemory: 0,
          totalCardinality: 0,
          maxCardinality: 0,
          totalIdleTime: 0,
          staleCount: 0,
          withTtl: 0,
          withoutTtl: 0,
          ttlValues: [],
          accessFrequencies: [],
        };

        try {
          let keyType = types[index];
          const sizeCommand = keyType ? SIZE_COMMAND_BY_TYPE.get(keyType) : undefined;
          let sentFreq = this.keyScanUsesLfu;
          const pipeline = this.client.pipeline();
          pipeline.memory('USAGE', key);
          this.queueObjectProbe(pipeline, key, sentFreq);
          pipeline.ttl(key);
          if (sizeCommand) pipeline.call(sizeCommand, key);

          const results = (await pipeline.exec()) || [];
          const [memResult, , ttlResult, sizeResult] = results;
          let objectResult = results[1];
          if (isLfuPolicyMismatch(objectResult?.[0])) {
            sentFreq = !sentFreq;
            this.keyScanUsesLfu = sentFreq;
            const retry = this.queueObjectProbe(this.client.pipeline(), key, sentFreq);
            objectResult = ((await retry.exec()) || [])[0];
          }
          const idleResult = sentFreq ? undefined : objectResult;
          const freqResult = sentFreq ? objectResult : undefined;

          stats.count++;

          const mem =
            memResult && !memResult[0] && memResult[1] != null ? (memResult[1] as number) : null;
          if (mem !== null) {
            stats.totalMemory += mem;
            if (mem > stats.maxMemory) stats.maxMemory = mem;
          }

          const cardinality =
            sizeResult && !sizeResult[0] && sizeResult[1] != null ? (sizeResult[1] as number) : null;
          // The key changed type since the batch TYPE, so that type is stale.
          if (sizeResult?.[0]?.message.startsWith('WRONGTYPE')) keyType = null;
          if (cardinality !== null) {
            stats.totalCardinality += cardinality;
            if (cardinality > stats.maxCardinality) stats.maxCardinality = cardinality;
          }

          const idle =
            idleResult && !idleResult[0] && idleResult[1] != null
              ? (idleResult[1] as number)
              : null;
          if (idle !== null) {
            stats.totalIdleTime += idle;
            if (idle > STALE_KEY_IDLE_SECONDS) {
              stats.staleCount = (stats.staleCount ?? 0) + 1;
            }
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
            keyType,
            cardinality,
            freqScore: freq,
            idleSeconds: idle,
            memoryBytes: mem,
            ttl: ttl ?? null,
          });
        } catch {
          // Skip keys that can't be inspected
        }
      }

      // Bound memory during a full-keyspace scan: keep only the keys that can
      // still surface as top-N hot / largest keys downstream. This also keeps
      // the JSON payload serialized back over the agent path small.
      if (keyDetails.length >= KEY_DETAILS_PRUNE_AT) {
        keyDetails = pruneKeyDetails(keyDetails);
      }

      if (!options.fullScan && scanned >= options.sampleSize) break;
    } while (cursor !== '0');

    return JSON.stringify({
      dbSize,
      scanned,
      patterns: Array.from(patternsMap.values()),
      keyDetails: pruneKeyDetails(keyDetails),
      db,
    });
  }

  private queueObjectProbe<P extends ReturnType<Valkey['pipeline']>>(
    pipeline: P,
    key: string,
    freq: boolean,
  ): P {
    if (freq) pipeline.object('FREQ', key);
    else pipeline.object('IDLETIME', key);
    return pipeline;
  }

  private async readKeyTypes(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const pipeline = this.client.pipeline();
    for (const key of keys) pipeline.type(key);
    let results: Awaited<ReturnType<typeof pipeline.exec>>;
    try {
      results = await pipeline.exec();
    } catch {
      // Scan the batch without size probes rather than failing the whole scan.
      return keys.map(() => null);
    }
    results = results || [];
    return keys.map((_, i) => {
      const result = results[i];
      return result && !result[0] && result[1] != null ? String(result[1]) : null;
    });
  }
}
