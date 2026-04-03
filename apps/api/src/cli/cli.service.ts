import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Valkey from 'iovalkey';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { parseCommandLine } from './command-parser';
import { CliResultMessage, CliErrorMessage } from './cli.types';

/**
 * Read-only commands allowed in safe mode (BETTERDB_UNSAFE_CLI !== 'true').
 * Mirrors the agent allowlist for consistency.
 */
const SAFE_COMMANDS = new Set([
  'PING',
  'ECHO',
  'INFO',
  'DBSIZE',
  'TIME',
  'LASTSAVE',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'KEYS',
  'SCAN',
  'RANDOMKEY',
  'OBJECT',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSCAN',
  'LLEN',
  'LRANGE',
  'LINDEX',
  'LPOS',
  'SCARD',
  'SISMEMBER',
  'SMISMEMBER',
  'SMEMBERS',
  'SRANDMEMBER',
  'SSCAN',
  'SUNION',
  'SINTER',
  'SDIFF',
  'ZCARD',
  'ZSCORE',
  'ZMSCORE',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZRANGEBYLEX',
  'ZREVRANGE',
  'ZREVRANGEBYSCORE',
  'ZREVRANGEBYLEX',
  'ZRANK',
  'ZREVRANK',
  'ZCOUNT',
  'ZLEXCOUNT',
  'ZSCAN',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'XINFO',
  'XPENDING',
  'MEMORY',
  'CLIENT',
  'CONFIG',
  'SLOWLOG',
  'LATENCY',
  'COMMAND',
  'ACL',
  'CLUSTER',
]);

/**
 * Sub-commands allowed in safe mode for multi-word commands.
 */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  CLIENT: new Set(['LIST', 'GETNAME', 'ID', 'INFO']),
  CONFIG: new Set(['GET']),
  SLOWLOG: new Set(['GET', 'LEN']),
  LATENCY: new Set(['LATEST', 'HISTORY']),
  COMMAND: new Set(['COUNT', 'INFO', 'LIST', 'DOCS']),
  ACL: new Set(['LIST', 'GETUSER', 'WHOAMI', 'CAT']),
  CLUSTER: new Set(['INFO', 'NODES', 'SLOTS', 'MYID', 'KEYSLOT']),
  MEMORY: new Set(['USAGE', 'DOCTOR', 'STATS']),
  OBJECT: new Set(['ENCODING', 'REFCOUNT', 'IDLETIME', 'HELP', 'FREQ']),
  XINFO: new Set(['STREAM', 'GROUPS', 'CONSUMERS']),
};

/**
 * Commands that are always blocked regardless of mode.
 * These are blocking, streaming, or dangerous commands.
 */
const BLOCKED_COMMANDS = new Set([
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'SSUBSCRIBE',
  'BLPOP',
  'BRPOP',
  'BRPOPLPUSH',
  'BLMOVE',
  'BLMPOP',
  'BZPOPMIN',
  'BZPOPMAX',
  'BZMPOP',
  'XREAD',
  'XREADGROUP',
  'WAIT',
  'WAITAOF',
  'MONITOR',
  'DEBUG',
]);

/**
 * Subcommands that are always blocked regardless of mode.
 */
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
  CLIENT: new Set(['PAUSE']),
};

@Injectable()
export class CliService implements OnModuleDestroy {
  private readonly logger = new Logger(CliService.name);
  private readonly clients = new Map<string, Valkey>();
  private readonly clientRefCounts = new Map<string, number>();
  private readonly connecting = new Map<string, Promise<Valkey>>();
  private readonly unsafeMode: boolean;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly configService: ConfigService,
  ) {
    this.unsafeMode = this.configService.get<boolean>('BETTERDB_UNSAFE_CLI') === true;
    if (this.unsafeMode) {
      this.logger.warn('CLI running in UNSAFE mode — all commands are allowed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];
    for (const [id, client] of this.clients) {
      disconnectPromises.push(
        client
          .quit()
          .then(() => this.logger.log(`CLI client disconnected: ${id}`))
          .catch((err: unknown) =>
            this.logger.error(
              `Error disconnecting CLI client ${id}: ${err instanceof Error ? err.message : err}`,
            ),
          ),
      );
    }
    await Promise.allSettled(disconnectPromises);
    this.clients.clear();
  }

  async execute(
    commandLine: string,
    connectionId?: string,
  ): Promise<CliResultMessage | CliErrorMessage> {
    const args = parseCommandLine(commandLine.trim());
    if (args.length === 0) {
      return { type: 'error', error: 'Empty command' };
    }

    const command = args[0].toUpperCase();
    const restArgs = args.slice(1);
    const subCommand = restArgs.length > 0 ? restArgs[0].toUpperCase() : undefined;

    // Check blocked commands
    const blockError = this.checkBlocked(command, subCommand);
    if (blockError) {
      return { type: 'error', error: blockError };
    }

    // Check safe mode restrictions
    if (!this.unsafeMode) {
      const safeError = this.checkSafeMode(command, subCommand);
      if (safeError) {
        return { type: 'error', error: safeError };
      }
    }

    // Get or create a dedicated CLI client
    let client: Valkey;
    try {
      client = await this.getOrCreateClient(connectionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: 'error', error: `Connection failed: ${msg}` };
    }

    // Execute command with timeout
    const COMMAND_TIMEOUT_MS = 30_000;
    const start = performance.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const resultPromise = client.call(command, ...restArgs);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Command timed out after 30s')),
          COMMAND_TIMEOUT_MS,
        );
      });
      const result: unknown = await Promise.race([resultPromise, timeoutPromise]);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const formatted = this.formatResult(result, durationMs);
      if (formatted.result.length > CliService.MAX_RESPONSE_SIZE) {
        formatted.result =
          formatted.result.slice(0, CliService.MAX_RESPONSE_SIZE) +
          '\n... (output truncated at 512 KB)';
      }
      return formatted;
    } catch (err: unknown) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: 'result',
        result: `(error) ${msg}`,
        resultType: 'error',
        durationMs,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Increment reference count for a connection's CLI client.
   */
  addClientRef(connectionId: string): void {
    this.clientRefCounts.set(connectionId, (this.clientRefCounts.get(connectionId) ?? 0) + 1);
  }

  /**
   * Decrement reference count and disconnect only when no WS clients remain.
   */
  releaseClientRef(connectionId: string): void {
    const count = (this.clientRefCounts.get(connectionId) ?? 1) - 1;
    if (count <= 0) {
      this.clientRefCounts.delete(connectionId);
      const client = this.clients.get(connectionId);
      if (client) {
        client.quit().catch((err: unknown) => {
          this.logger.warn(
            `Error quitting CLI client ${connectionId}: ${err instanceof Error ? err.message : err}`,
          );
        });
        this.clients.delete(connectionId);
      }
    } else {
      this.clientRefCounts.set(connectionId, count);
    }
  }

  private checkBlocked(command: string, subCommand?: string): string | null {
    if (BLOCKED_COMMANDS.has(command)) {
      return `Command ${command} is blocked. It may block the connection or is dangerous.`;
    }
    if (subCommand && BLOCKED_SUBCOMMANDS[command]?.has(subCommand)) {
      return `Command ${command} ${subCommand} is blocked.`;
    }
    return null;
  }

  private checkSafeMode(command: string, subCommand?: string): string | null {
    if (!SAFE_COMMANDS.has(command)) {
      return (
        `Command ${command} is not allowed in safe mode. ` +
        'Set BETTERDB_UNSAFE_CLI=true to enable all commands.'
      );
    }

    // If the command has sub-command restrictions, validate
    const allowedSubs = SAFE_SUBCOMMANDS[command];
    if (allowedSubs) {
      if (!subCommand) {
        return `Command ${command} requires a sub-command in safe mode (e.g., ${command} ${[...allowedSubs][0]}).`;
      }
      if (!allowedSubs.has(subCommand)) {
        return (
          `Command ${command} ${subCommand} is not allowed in safe mode. ` +
          'Set BETTERDB_UNSAFE_CLI=true to enable all commands.'
        );
      }
    }

    return null;
  }

  private async getOrCreateClient(connectionId?: string): Promise<Valkey> {
    const config = this.connectionRegistry.getConfig(connectionId);
    if (!config) {
      throw new Error(
        connectionId
          ? `Connection '${connectionId}' not found`
          : 'No default connection available',
      );
    }

    if (config.credentialStatus === 'decryption_failed') {
      throw new Error(
        `Cannot connect: password decryption failed for "${config.name}". ` +
        'Fix ENCRYPTION_KEY and restart the server.',
      );
    }

    const key = config.id;
    const existing = this.clients.get(key);
    if (existing && existing.status === 'ready') {
      return existing;
    }

    // Prevent duplicate connections from concurrent messages
    const inflight = this.connecting.get(key);
    if (inflight) {
      return inflight;
    }

    // Clean up stale client if exists
    if (existing) {
      existing.quit().catch(() => {});
      this.clients.delete(key);
    }

    const connectPromise = (async (): Promise<Valkey> => {
      const client = new Valkey({
        host: config.host,
        port: config.port,
        username: config.username || 'default',
        password: config.password || undefined,
        db: config.dbIndex ?? 0,
        connectionName: 'BetterDB-CLI',
        lazyConnect: true,
        enableReadyCheck: true,
        retryStrategy: (): null => null,
      });

      await client.connect();
      this.clients.set(key, client);
      return client;
    })();

    this.connecting.set(key, connectPromise);
    try {
      return await connectPromise;
    } finally {
      this.connecting.delete(key);
    }
  }

  private static readonly MAX_RESPONSE_SIZE = 512 * 1024; // 512 KB

  private formatResult(value: unknown, durationMs: number): CliResultMessage {
    if (value === null || value === undefined) {
      return { type: 'result', result: '(nil)', resultType: 'nil', durationMs };
    }

    if (typeof value === 'number') {
      return {
        type: 'result',
        result: `(integer) ${value}`,
        resultType: 'integer',
        durationMs,
      };
    }

    if (Buffer.isBuffer(value)) {
      return {
        type: 'result',
        result: `"${value.toString()}"`,
        resultType: 'string',
        durationMs,
      };
    }

    if (typeof value === 'string') {
      return {
        type: 'result',
        result: `"${value}"`,
        resultType: 'string',
        durationMs,
      };
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { type: 'result', result: '(empty array)', resultType: 'empty-array', durationMs };
      }
      return {
        type: 'result',
        result: this.formatArray(value, 0),
        resultType: 'array',
        durationMs,
      };
    }

    // Fallback
    return {
      type: 'result',
      result: `"${String(value)}"`,
      resultType: 'string',
      durationMs,
    };
  }

  private formatArray(arr: unknown[], depth: number): string {
    const indent = '   '.repeat(depth);
    return arr
      .map((item, index) => {
        const prefix = `${indent}${index + 1}) `;
        if (item === null || item === undefined) {
          return `${prefix}(nil)`;
        }
        if (Array.isArray(item)) {
          if (item.length === 0) {
            return `${prefix}(empty array)`;
          }
          return `${prefix}\n${this.formatArray(item, depth + 1)}`;
        }
        if (typeof item === 'number') {
          return `${prefix}(integer) ${item}`;
        }
        return `${prefix}"${String(item)}"`;
      })
      .join('\n');
  }
}
