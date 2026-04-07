import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { checkBlocked, checkSafeMode } from '@betterdb/shared';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { parseCommandLine } from './command-parser';
import { CliResultMessage, CliErrorMessage } from './cli.types';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';

@Injectable()
export class CliService {
  private readonly logger = new Logger(CliService.name);
  private readonly unsafeMode: boolean;
  private static readonly MAX_RESPONSE_SIZE = 512 * 1024; // 512 KB

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly configService: ConfigService,
  ) {
    this.unsafeMode = this.configService.get<string>('BETTERDB_UNSAFE_CLI') === 'true';
    if (this.unsafeMode) {
      this.logger.warn('CLI running in UNSAFE mode — all commands are allowed');
    }
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

    const blockError = checkBlocked(command, subCommand);
    if (blockError) {
      return { type: 'error', error: blockError };
    }

    if (!this.unsafeMode) {
      const safeError = checkSafeMode(command, subCommand);
      if (safeError) {
        return {
          type: 'error',
          error: safeError + ' Set BETTERDB_UNSAFE_CLI=true to enable all commands.',
        };
      }
    }

    let adapter: DatabasePort;
    try {
      adapter = this.connectionRegistry.get(connectionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: 'error', error: msg };
    }

    const COMMAND_TIMEOUT_MS = 30_000;
    const start = performance.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const resultPromise = adapter.call(command, restArgs, { cli: true });
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
      return { type: 'result', result: value.toString(), resultType: 'string', durationMs };
    }

    if (typeof value === 'string') {
      return { type: 'result', result: value, resultType: 'string', durationMs };
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
      result: String(value),
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
        return `${prefix}${String(item)}`;
      })
      .join('\n');
  }
}
