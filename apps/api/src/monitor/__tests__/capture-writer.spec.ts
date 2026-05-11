import { EventEmitter } from 'events';
import { CaptureWriter, MonitorSource } from '../capture-writer';

class FakeSource extends EventEmitter implements MonitorSource {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
  push(line: string): void {
    this.emit('line', line);
  }
  end(): void {
    this.emit('end');
  }
  fail(err: Error): void {
    this.emit('error', err);
  }
}

interface FakeStorage {
  saveCaptureChunk: jest.Mock;
  updateCaptureSession: jest.Mock;
  chunks: Array<{
    sessionId: string;
    chunkIndex: number;
    bytes: Buffer;
    lineCount: number;
    firstTs: number;
    lastTs: number;
  }>;
  patches: Array<{ id: string; patch: unknown }>;
  saveDelay: number;
}

function makeStorage({ saveDelay = 0 }: { saveDelay?: number } = {}): FakeStorage {
  const fake: FakeStorage = {
    saveCaptureChunk: jest.fn(),
    updateCaptureSession: jest.fn(),
    chunks: [],
    patches: [],
    saveDelay,
  };
  fake.saveCaptureChunk.mockImplementation(async (chunk) => {
    fake.chunks.push(chunk);
    if (fake.saveDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, fake.saveDelay));
    }
    return 1;
  });
  fake.updateCaptureSession.mockImplementation(async (id: string, patch: unknown) => {
    fake.patches.push({ id, patch });
    return true;
  });
  return fake;
}

const SESSION_ID = 'sess-1';

describe('CaptureWriter', () => {
  describe('happy path', () => {
    it('completes when the source ends and persists buffered lines as one chunk', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 10_000,
        lineCap: 10_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      source.push('+1700000000.000 [0 1.2.3.4:5] "GET" "foo"');
      source.push('+1700000000.001 [0 1.2.3.4:5] "SET" "foo" "bar"');
      source.end();

      const result = await done;
      expect(result.status).toBe('completed');
      expect(result.lineCount).toBe(2);
      expect(result.byteCount).toBeGreaterThan(0);
      expect(storage.chunks).toHaveLength(1);
      expect(storage.chunks[0]).toMatchObject({
        sessionId: SESSION_ID,
        chunkIndex: 0,
        lineCount: 2,
      });
      expect(source.stopped).toBe(true);
    });

    it('finalizes the session row with end status, counters, and reason', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 10_000,
        lineCap: 10_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      source.push('one');
      source.push('two');
      writer.stop('manual_stop');
      const result = await done;

      expect(result.status).toBe('completed');
      expect(result.terminationReason).toBe('manual_stop');
      expect(storage.patches).toHaveLength(1);
      expect(storage.patches[0]).toMatchObject({
        id: SESSION_ID,
        patch: expect.objectContaining({
          status: 'completed',
          terminationReason: 'manual_stop',
          lineCount: 2,
        }),
      });
    });
  });

  describe('cap enforcement', () => {
    it('truncates with reason "byte_cap" when byteCount reaches byteCap', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 50,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      // Each line ~30 bytes (incl. newline) — second line trips the 50-byte cap.
      source.push('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      source.push('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      const result = await done;
      expect(result.status).toBe('truncated');
      expect(result.terminationReason).toBe('byte_cap');
      expect(source.stopped).toBe(true);
    });

    it('truncates with reason "line_cap" when lineCount reaches lineCap', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 3,
        durationMs: 60_000,
      });

      const done = writer.start();
      source.push('a');
      source.push('b');
      source.push('c'); // trips the cap

      const result = await done;
      expect(result.status).toBe('truncated');
      expect(result.terminationReason).toBe('line_cap');
      expect(result.lineCount).toBe(3);
    });

    it('completes with reason "duration_cap" when durationMs elapses', async () => {
      jest.useFakeTimers();
      try {
        const source = new FakeSource();
        const storage = makeStorage();
        const writer = new CaptureWriter({
          sessionId: SESSION_ID,
          source,
          storage,
          byteCap: 1_000_000,
          lineCap: 1_000_000,
          durationMs: 100,
        });

        const done = writer.start();
        source.push('one');
        jest.advanceTimersByTime(101);
        // need to flush microtasks / promise chain
        await Promise.resolve();
        await Promise.resolve();

        jest.useRealTimers();
        const result = await done;
        expect(result.status).toBe('completed');
        expect(result.terminationReason).toBe('duration_cap');
        expect(source.stopped).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('chunk batching and ordering', () => {
    it('flushes when the line threshold is hit and assigns sequential chunk indexes', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
        flushLineThreshold: 3,
      });

      const done = writer.start();
      for (let i = 0; i < 8; i++) source.push(`line-${i}`);
      source.end();
      await done;

      // 8 lines, threshold 3 → chunks of sizes [3, 3, 2]
      expect(storage.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
      expect(storage.chunks.map((c) => c.lineCount)).toEqual([3, 3, 2]);
    });

    it('persists chunks in the same order they were buffered', async () => {
      const source = new FakeSource();
      const storage = makeStorage({ saveDelay: 5 });
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
        flushLineThreshold: 2,
      });

      const done = writer.start();
      for (let i = 0; i < 6; i++) source.push(`line-${i}`);
      source.end();
      await done;

      // Indexes are monotonic
      const indexes = storage.chunks.map((c) => c.chunkIndex);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));

      // Lines within and across chunks preserve original order
      const reconstructed = storage.chunks
        .map((c) => c.bytes.toString('utf-8').split('\n'))
        .flat();
      expect(reconstructed).toEqual([
        'line-0',
        'line-1',
        'line-2',
        'line-3',
        'line-4',
        'line-5',
      ]);
    });
  });

  describe('ring buffer for tail readers', () => {
    it('keeps only the most recent N lines', () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
        ringBufferSize: 3,
      });

      writer.start();
      for (let i = 0; i < 10; i++) source.push(`line-${i}`);

      expect(writer.getRingBuffer()).toEqual(['line-7', 'line-8', 'line-9']);
    });

    it('does not block the writer when many viewers read concurrently', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
        ringBufferSize: 100,
      });

      const done = writer.start();

      // Simulate 10 viewers polling the ring buffer while lines stream in
      const viewerSnapshots: string[][] = [];
      for (let i = 0; i < 50; i++) {
        source.push(`line-${i}`);
        if (i % 5 === 0) {
          for (let v = 0; v < 10; v++) {
            viewerSnapshots.push(writer.getRingBuffer());
          }
        }
      }
      source.end();
      await done;

      // All 50 lines made it to the writer's accounting
      expect(writer.getCounters().lineCount).toBe(50);
      // Viewer snapshots are independent reads, none mutated state
      expect(viewerSnapshots.length).toBeGreaterThan(0);
    });
  });

  describe('backpressure isolation', () => {
    it('keeps consuming lines while storage writes are slow', async () => {
      const source = new FakeSource();
      const storage = makeStorage({ saveDelay: 50 });
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
        flushLineThreshold: 2,
      });

      const done = writer.start();

      // Push 20 lines synchronously — the writer must accept all of them even
      // though saveCaptureChunk takes 50ms per chunk.
      for (let i = 0; i < 20; i++) source.push(`line-${i}`);
      expect(writer.getCounters().lineCount).toBe(20); // counted immediately

      source.end();
      await done;
      expect(storage.chunks.reduce((s, c) => s + c.lineCount, 0)).toBe(20);
    });
  });

  describe('subscribe / onEnd', () => {
    it('delivers each ingested line to every subscriber, in order', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const a: string[] = [];
      const b: string[] = [];
      const done = writer.start();
      writer.subscribe((l) => a.push(l));
      writer.subscribe((l) => b.push(l));

      source.push('one');
      source.push('two');
      source.push('three');
      source.end();
      await done;

      expect(a).toEqual(['one', 'two', 'three']);
      expect(b).toEqual(['one', 'two', 'three']);
    });

    it('unsubscribe stops further deliveries to that subscriber', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const a: string[] = [];
      const done = writer.start();
      const unsub = writer.subscribe((l) => a.push(l));
      source.push('one');
      unsub();
      source.push('two');
      source.end();
      await done;
      expect(a).toEqual(['one']);
    });

    it('a throwing subscriber does not affect the writer or other subscribers', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const good: string[] = [];
      const done = writer.start();
      writer.subscribe(() => {
        throw new Error('viewer crashed');
      });
      writer.subscribe((l) => good.push(l));

      source.push('one');
      source.push('two');
      source.end();
      const result = await done;
      expect(result.lineCount).toBe(2);
      expect(good).toEqual(['one', 'two']);
    });

    it('onEnd fires once on termination', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const ends: number[] = [];
      const done = writer.start();
      writer.onEnd(() => ends.push(1));
      writer.onEnd(() => ends.push(2));

      source.end();
      await done;
      expect(ends).toEqual([1, 2]);
    });
  });

  describe('failure modes', () => {
    it('reports status="failed" on source error', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      source.push('one');
      source.fail(new Error('connection lost'));

      const result = await done;
      expect(result.status).toBe('failed');
      expect(result.terminationReason).toBe('source_error: connection lost');
    });

    it('is idempotent across multiple stop / terminate calls', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      writer.stop('first');
      writer.stop('second');
      writer.stop('third');
      const result = await done;
      expect(result.terminationReason).toBe('first');
      expect(storage.patches).toHaveLength(1);
    });

    it('still finalizes when storage.saveCaptureChunk rejects', async () => {
      const source = new FakeSource();
      const storage = makeStorage();
      storage.saveCaptureChunk.mockRejectedValueOnce(new Error('disk full'));

      const writer = new CaptureWriter({
        sessionId: SESSION_ID,
        source,
        storage,
        byteCap: 1_000_000,
        lineCap: 1_000_000,
        durationMs: 60_000,
      });

      const done = writer.start();
      source.push('one');
      source.end();
      const result = await done;
      // Persistence failure should not prevent the session from finalizing.
      expect(result.status).toBe('completed');
      expect(storage.patches).toHaveLength(1);
    });
  });
});
