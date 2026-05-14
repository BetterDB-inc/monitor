import { Logger } from '@nestjs/common';
import { StoragePort } from '../common/interfaces/storage-port.interface';

/**
 * Source of MONITOR-formatted text lines. The CaptureWriter consumes lines from
 * here without caring how they were produced. The iovalkey adapter wraps a
 * MONITOR connection in this contract; tests pass in a fake EventEmitter.
 */
export interface MonitorSource {
  on(event: 'line', cb: (line: string) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  off?(event: string, cb: (...args: unknown[]) => void): unknown;
  /** Stop the underlying source connection. Idempotent. */
  stop(): void;
}

export interface CaptureWriterOptions {
  sessionId: string;
  source: MonitorSource;
  storage: Pick<StoragePort, 'saveCaptureChunk' | 'updateCaptureSession'>;
  byteCap: number;
  lineCap: number;
  /** Hard duration cap in ms; the writer self-terminates after this. */
  durationMs: number;
  /** Flush a chunk no later than this many ms after the first line in the chunk. */
  flushIntervalMs?: number;
  /** Flush a chunk when it reaches this many lines, even before the interval elapses. */
  flushLineThreshold?: number;
  /** Size of the in-memory ring buffer (most-recent N lines) exposed for tail readers. */
  ringBufferSize?: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

export type CaptureWriterStatus = 'completed' | 'truncated' | 'failed';

export interface CaptureWriterResult {
  status: CaptureWriterStatus;
  terminationReason: string;
  byteCount: number;
  lineCount: number;
  endedAt: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_LINE_THRESHOLD = 5000;
const DEFAULT_RING_BUFFER_SIZE = 10000;

/**
 * Drains a MONITOR stream into capture_chunks rows and an in-memory ring buffer.
 *
 * Hard contract:
 *  - One writer per session.
 *  - Lines are buffered into a "current chunk" and flushed when either the line
 *    threshold or the flush interval is hit. Flushes happen asynchronously via a
 *    serialized write queue so the source-line callback never awaits storage.
 *  - When byteCap, lineCap, or durationMs is hit, the writer stops the source,
 *    flushes pending data, and resolves with status='truncated' (caps) or
 *    'completed' (duration).
 *  - External stop() resolves with status='completed' and terminationReason='manual_stop'.
 *  - Source 'error' resolves with status='failed' and the error message in
 *    terminationReason. Source 'end' resolves with whatever status was most
 *    recently set (default 'completed').
 *  - The ring buffer is in-memory and bounded; viewers read snapshots and never
 *    block the writer.
 */
export class CaptureWriter {
  private readonly logger: Logger;

  private readonly sessionId: string;
  private readonly source: MonitorSource;
  private readonly storage: CaptureWriterOptions['storage'];
  private readonly byteCap: number;
  private readonly lineCap: number;
  private readonly durationMs: number;
  private readonly flushIntervalMs: number;
  private readonly flushLineThreshold: number;
  private readonly ringBufferSize: number;
  private readonly now: () => number;

  private buffer: string[] = [];
  private bufferBytes = 0;
  private bufferFirstTs = 0;

  private byteCount = 0;
  private lineCount = 0;
  private chunkIndex = 0;

  /** Most recent N lines for tail readers, oldest-first. */
  private ringBuffer: string[] = [];

  private status: CaptureWriterStatus = 'completed';
  private terminationReason = 'source_ended';
  private stopped = false;
  private startedAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private resolveDone: ((result: CaptureWriterResult) => void) | null = null;
  private donePromise: Promise<CaptureWriterResult>;

  constructor(opts: CaptureWriterOptions) {
    this.sessionId = opts.sessionId;
    this.logger = new Logger(`${CaptureWriter.name}[${opts.sessionId}]`);
    this.source = opts.source;
    this.storage = opts.storage;
    this.byteCap = opts.byteCap;
    this.lineCap = opts.lineCap;
    this.durationMs = opts.durationMs;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushLineThreshold = opts.flushLineThreshold ?? DEFAULT_FLUSH_LINE_THRESHOLD;
    this.ringBufferSize = opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;
    this.now = opts.now ?? Date.now;

    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /**
   * Start consuming lines. Returns a promise that resolves with the final
   * status/counters when the writer terminates.
   */
  start(): Promise<CaptureWriterResult> {
    this.startedAt = this.now();

    this.source.on('line', (line) => this.handleLine(line));
    this.source.on('error', (err) => this.terminate('failed', `source_error: ${err.message}`));
    this.source.on('end', () => this.terminate(this.status, this.terminationReason));

    this.durationTimer = setTimeout(() => {
      this.terminate('completed', 'duration_cap');
    }, this.durationMs);

    return this.donePromise;
  }

  /** External stop request. Idempotent. */
  stop(reason = 'manual_stop'): void {
    this.terminate('completed', reason);
  }

  /** Snapshot of the most recent ring-buffer lines (oldest-first). */
  getRingBuffer(): string[] {
    return [...this.ringBuffer];
  }

  getCounters(): { byteCount: number; lineCount: number } {
    return { byteCount: this.byteCount, lineCount: this.lineCount };
  }

  private handleLine(line: string): void {
    if (this.stopped) return;

    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for the joining newline

    this.byteCount += lineBytes;
    this.lineCount += 1;

    this.buffer.push(line);
    this.bufferBytes += lineBytes;
    if (this.buffer.length === 1) {
      this.bufferFirstTs = this.now();
      this.armFlushTimer();
    }

    this.pushRingBuffer(line);

    if (this.byteCount >= this.byteCap) {
      this.terminate('truncated', 'byte_cap');
      return;
    }
    if (this.lineCount >= this.lineCap) {
      this.terminate('truncated', 'line_cap');
      return;
    }
    if (this.buffer.length >= this.flushLineThreshold) {
      this.flush();
    }
  }

  private pushRingBuffer(line: string): void {
    this.ringBuffer.push(line);
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.splice(0, this.ringBuffer.length - this.ringBufferSize);
    }
  }

  private armFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const chunkLines = this.buffer;
    const chunkLineCount = chunkLines.length;
    const firstTs = this.bufferFirstTs;
    const lastTs = this.now();
    const chunkIndex = this.chunkIndex++;

    this.buffer = [];
    this.bufferBytes = 0;
    this.bufferFirstTs = 0;

    // Sequential, never-blocks-the-handler write path.
    this.writeQueue = this.writeQueue.then(() =>
      this.storage
        .saveCaptureChunk({
          sessionId: this.sessionId,
          chunkIndex,
          bytes: Buffer.from(chunkLines.join('\n'), 'utf-8'),
          lineCount: chunkLineCount,
          firstTs,
          lastTs,
        })
        .then(() => undefined)
        .catch((err: Error) => {
          this.logger.error(`Failed to persist chunk ${chunkIndex}: ${err.message}`);
        }),
    );
  }

  private async terminate(status: CaptureWriterStatus, reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.status = status;
    this.terminationReason = reason;

    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    try {
      this.source.stop();
    } catch (err) {
      this.logger.warn(`source.stop threw: ${(err as Error).message}`);
    }

    this.flush();

    // Wait for the in-flight write queue to drain.
    try {
      await this.writeQueue;
    } catch {
      // queue items already log their own errors
    }

    const endedAt = this.now();

    try {
      await this.storage.updateCaptureSession(this.sessionId, {
        status,
        endedAt,
        durationMs: endedAt - this.startedAt,
        byteCount: this.byteCount,
        lineCount: this.lineCount,
        terminationReason: reason,
      });
    } catch (err) {
      this.logger.error(`Failed to finalize session row: ${(err as Error).message}`);
    }

    this.resolveDone?.({
      status,
      terminationReason: reason,
      byteCount: this.byteCount,
      lineCount: this.lineCount,
      endedAt,
    });
    this.resolveDone = null;
  }
}
