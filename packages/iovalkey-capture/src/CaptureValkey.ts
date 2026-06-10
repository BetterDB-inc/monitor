import { Redis } from 'iovalkey';
import type { RedisOptions } from 'iovalkey';
import { randomUUID } from 'node:crypto';
import type {
  CaptureConfig,
  CapturedCommand,
  CaptureStats,
  CaptureBatchRequest,
  CaptureWindowResponse,
} from './types';

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFERED = 100_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

export interface CaptureValkeyOptions extends RedisOptions {
  capture: CaptureConfig;
}

export class CaptureValkey extends Redis {
  readonly connectionId: string;

  private readonly captureConfig: CaptureConfig;
  private readonly batchSize: number;
  private readonly maxBuffered: number;

  private buffer: CapturedCommand[] = [];
  private capturing = false;
  private windowCommandCap: number | undefined;
  private windowCapturedCount = 0;

  private capturedCount = 0;
  private droppedCount = 0;
  private failedFlushCount = 0;
  private errorCount = 0;

  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(port: number, host: string, options: CaptureValkeyOptions);
  constructor(path: string, options: CaptureValkeyOptions);
  constructor(port: number, options: CaptureValkeyOptions);
  constructor(options: CaptureValkeyOptions);
  constructor(
    arg1: number | string | CaptureValkeyOptions,
    arg2?: string | CaptureValkeyOptions,
    arg3?: CaptureValkeyOptions,
  ) {
    // Extract capture config from whichever arg is the options object.
    let captureConfig: CaptureConfig | undefined;
    for (const arg of [arg3, arg2, arg1]) {
      if (arg && typeof arg === 'object' && 'capture' in arg) {
        captureConfig = (arg as CaptureValkeyOptions).capture;
        break;
      }
    }
    if (!captureConfig) {
      throw new Error('CaptureValkey requires a `capture` config in options');
    }

    // Pass all args through to iovalkey. Extra `capture` key is ignored by parseOptions.
    super(arg1 as number, arg2 as string, arg3 as RedisOptions);

    this.connectionId = randomUUID();
    this.captureConfig = captureConfig;
    this.batchSize = captureConfig.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxBuffered = captureConfig.maxBufferedCommands ?? DEFAULT_MAX_BUFFERED;

    this.startFlushTimer(captureConfig.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.startPollTimer(captureConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  // -- sendCommand override --

  sendCommand(command: { name: string; args: unknown[] }, ...rest: unknown[]): unknown {
    if (this.capturing) {
      try {
        if (this.buffer.length >= this.maxBuffered) {
          this.droppedCount++;
        } else {
          const record: CapturedCommand = {
            connectionId: this.connectionId,
            name: command.name,
            args: command.args.map((a) => (a === null || a === undefined ? '' : String(a))),
            ts: Date.now(),
          };
          this.buffer.push(record);
          this.capturedCount++;
          this.windowCapturedCount++;

          if (this.buffer.length >= this.batchSize) {
            void this.flush();
          }

          if (this.windowCommandCap !== undefined && this.windowCapturedCount >= this.windowCommandCap) {
            void this.endCaptureWindow();
          }
        }
      } catch {
        this.errorCount++;
      }
    }

    return super.sendCommand(command as never, ...(rest as []));
  }

  // -- Stats --

  stats(): CaptureStats {
    return {
      capturedCount: this.capturedCount,
      droppedCount: this.droppedCount,
      failedFlushCount: this.failedFlushCount,
      errorCount: this.errorCount,
      buffered: this.buffer.length,
    };
  }

  // -- Flush --

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    const body: CaptureBatchRequest = {
      connectionId: this.connectionId,
      commands: batch,
    };

    try {
      const instanceId = encodeURIComponent(this.captureConfig.instanceId);
      const resp = await fetch(`${this.captureConfig.monitorUrl}/api/capture/instance/${instanceId}/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.captureConfig.token}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        this.failedFlushCount++;
      }
    } catch {
      this.failedFlushCount++;
    }
  }

  // -- Capture window polling --

  private async poll(): Promise<void> {
    try {
      const instanceId = encodeURIComponent(this.captureConfig.instanceId);
      const resp = await fetch(`${this.captureConfig.monitorUrl}/api/capture/instance/${instanceId}/window`, {
        headers: {
          'Authorization': `Bearer ${this.captureConfig.token}`,
        },
      });
      if (!resp.ok) return;

      const data = (await resp.json()) as CaptureWindowResponse;

      if (data.active && !this.capturing) {
        this.capturing = true;
        this.windowCapturedCount = 0;
        this.windowCommandCap = data.maxCommands;
        if (data.maxDurationMs !== undefined) {
          setTimeout(() => void this.endCaptureWindow(), data.maxDurationMs);
        }
      } else if (!data.active && this.capturing) {
        void this.endCaptureWindow();
      }
    } catch {
      this.errorCount++;
    }
  }

  private async endCaptureWindow(): Promise<void> {
    this.capturing = false;
    this.windowCommandCap = undefined;
    await this.flush();
  }

  // -- Timers --

  private startFlushTimer(intervalMs: number): void {
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    this.flushTimer.unref();
  }

  private startPollTimer(intervalMs: number): void {
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    this.pollTimer.unref();
    // Fire immediately so the first poll doesn't wait a full interval
    void this.poll();
  }

  /**
   * Clean up timers. Call before disconnecting if you want deterministic shutdown.
   */
  async destroyCapture(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.flush();
  }
}
