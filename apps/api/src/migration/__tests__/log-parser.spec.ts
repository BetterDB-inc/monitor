import { parseLogLine, classifyRedisShakeFailure, stripAnsi } from '../execution/log-parser';

describe('stripAnsi', () => {
  it('removes CSI colour codes, including a wrapped level token', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mERR\x1b[0m done')).toBe('ERR done');
    expect(stripAnsi('\x1b[90m2026-01-01\x1b[0m INF start')).toBe('2026-01-01 INF start');
  });
  it('is a no-op on plain text', () => {
    expect(stripAnsi('plain line')).toBe('plain line');
  });
});

describe('parseLogLine — sync_reader stage detection', () => {
  it('returns null syncStage for unrelated lines', () => {
    expect(parseLogLine('some random log line').syncStage).toBeNull();
    expect(parseLogLine('').syncStage).toBeNull();
  });

  it('detects connecting stage from connect lines', () => {
    expect(parseLogLine('connect to 10.0.0.1:6379').syncStage).toBe('connecting');
    expect(parseLogLine('connecting to source').syncStage).toBe('connecting');
    expect(parseLogLine('PSYNC handshake started').syncStage).toBe('connecting');
  });

  it('detects rdb_syncing stage from rdb-transfer lines', () => {
    expect(parseLogLine('start full sync').syncStage).toBe('rdb_syncing');
    expect(parseLogLine('send rdb to writer').syncStage).toBe('rdb_syncing');
    expect(parseLogLine('receiving rdb chunk').syncStage).toBe('rdb_syncing');
  });

  it('detects aof_replicating stage from rdb-done and incr lines', () => {
    expect(parseLogLine('rdb send finished').syncStage).toBe('aof_replicating');
    expect(parseLogLine('full sync done').syncStage).toBe('aof_replicating');
    expect(parseLogLine('incr sync started').syncStage).toBe('aof_replicating');
    expect(parseLogLine('receive offset=12345').syncStage).toBe('aof_replicating');
    expect(parseLogLine('master_offset=98765').syncStage).toBe('aof_replicating');
  });

  it('detects aof_replicating from the periodic stats "syncing aof" line', () => {
    const line = 'read_count=[26000], read_ops=[0.00], write_count=[26000], write_ops=[5199.92], src-2, syncing aof, diff=[0]';
    expect(parseLogLine(line).syncStage).toBe('aof_replicating');
  });

  it('extracts write_count from sync_reader periodic stats line', () => {
    const line = 'read_count=[26000], read_ops=[0.00], write_count=[26000], write_ops=[5199.92], src-2, syncing aof, diff=[0]';
    const result = parseLogLine(line);
    expect(result.keysTransferred).toBe(26000);
    expect(result.syncStage).toBe('aof_replicating');
  });

  it('write_count takes priority over scanned on the same line', () => {
    // A pathological line containing both patterns — write_count must win
    const line = 'write_count=[500], scanned=999, total=1000, syncing aof';
    const result = parseLogLine(line);
    expect(result.keysTransferred).toBe(500);
  });

  it('extracts write_count=0 without treating it as null', () => {
    const line = 'read_count=[0], read_ops=[0.00], write_count=[0], write_ops=[0.00], src-0, syncing aof, diff=[1048576]';
    const result = parseLogLine(line);
    expect(result.keysTransferred).toBe(0);
  });

  it('prioritizes aof_replicating over rdb_syncing on ambiguous lines', () => {
    // A line that mentions both rdb and incr should land on the later stage
    expect(parseLogLine('rdb send finished, starting incr sync').syncStage).toBe('aof_replicating');
  });

  it('preserves existing scan-mode parsing behavior', () => {
    const result = parseLogLine('{"key_counts":{"scanned":100,"total":1000}}');
    expect(result.keysTransferred).toBe(100);
    expect(result.progress).toBe(10);
    expect(result.syncStage).toBeNull();
  });

  it('combines metrics and stage when both are present', () => {
    const result = parseLogLine('start full sync, scanned=50, total=200');
    expect(result.syncStage).toBe('rdb_syncing');
    expect(result.keysTransferred).toBe(50);
    expect(result.progress).toBe(25);
  });
});

describe('parseLogLine — scan_reader behavior preserved', () => {
  it('parses JSON counts', () => {
    const result = parseLogLine('{"counts":{"scanned":42,"total":100}}');
    expect(result.keysTransferred).toBe(42);
    expect(result.progress).toBe(42);
  });

  it('parses regex scanned/total', () => {
    const result = parseLogLine('progress: scanned=500 total=2000');
    expect(result.keysTransferred).toBe(500);
    expect(result.progress).toBe(25);
  });

  it('returns NULL_RESULT for unparseable lines', () => {
    const result = parseLogLine('not a metrics line');
    expect(result.keysTransferred).toBeNull();
    expect(result.bytesTransferred).toBeNull();
    expect(result.progress).toBeNull();
    expect(result.syncStage).toBeNull();
  });
});

describe('classifyRedisShakeFailure', () => {
  it('detects BUSYKEY on the real v4.6.1 fatal ERR line (log.Panicf: zerolog ERR + os.Exit)', () => {
    // Actual shape RedisShake v4.6.1 produces: an `ERR` zerolog line carrying the
    // BUSYKEY reply, followed by Panicf's appended call frame (`…/*.go:NN -> fn()`).
    // No Go panic, no stack dump. The frame line is dropped; the ERR line classifies.
    const logs = [
      '2026-08-18 10:00:00 INF [src-0] start syncing rdb. path=[/tmp/dump.rdb]',
      '2026-08-18 10:00:01 ERR [src-0] redisStandaloneWriter received BUSYKEY reply. cmd=[RESTORE mykey 0 ...]',
      '\t\t\tRedisShake/internal/writer/redis_standalone_writer.go:168 -> processReply()',
    ];
    const result = classifyRedisShakeFailure(1, logs);
    expect(result.code).toBe('BUSYKEY');
    expect(result.message).toMatch(/flush the target/i);
  });

  it('keys off the last ERR line, so an earlier error is not misattributed as BUSYKEY', () => {
    // Defensive: if two ERR lines appear, the fatal one is last (it precedes os.Exit).
    // A BUSYKEY earlier in the buffer must not override a different final cause.
    const logs = [
      '2026-08-18 10:00:00 ERR [src-0] transient reply BUSYKEY on key foo',
      '2026-08-18 10:00:05 INF [src-0] retrying',
      '2026-08-18 10:00:10 ERR [src-0] OOM command not allowed when used memory > maxmemory',
    ];
    expect(classifyRedisShakeFailure(1, logs).code).toBe('UNKNOWN');
  });

  it('uses the last non-empty line when no ERR/panic/FATAL marker is present', () => {
    const logs = ['some progress', 'BUSYKEY on final line', ''];
    expect(classifyRedisShakeFailure(1, logs).code).toBe('BUSYKEY');
  });

  it('classifies BUSYKEY from real ANSI-coloured RedisShake output', () => {
    // Exactly what v4.6.x emits on a BUSYKEY abort: an ANSI-wrapped ERR level token
    // (so `\bERR\b` fails until stripped), then the appended .go and .s call frames.
    // `\x1b` escapes reproduce the colour codes the binary actually writes.
    const raw = [
      '\x1b[90m2026-08-18 18:06:52\x1b[0m \x1b[1m\x1b[31mERR\x1b[0m [writer_127.0.0.1_6402] redisStandaloneWriter received BUSYKEY reply. cmd=[RESTORE foo 0 ...]',
      '\t\t\tRedisShake/internal/writer/redis_standalone_writer.go:158 -> (*redisStandaloneWriter).processReply()',
      '\t\t\truntime/asm_amd64.s:1650 -> goexit()',
    ];
    const logs = raw.map(stripAnsi); // mirrors processLine's per-line handling
    expect(classifyRedisShakeFailure(1, logs).code).toBe('BUSYKEY');
  });

  it('is case-insensitive on the BUSYKEY token', () => {
    expect(classifyRedisShakeFailure(1, ['busykey seen']).code).toBe('BUSYKEY');
  });

  it('appends the exit code to the BUSYKEY message', () => {
    expect(classifyRedisShakeFailure(2, ['BUSYKEY']).message).toContain('(exit code 2)');
  });

  it('handles a null exit code without printing "null"', () => {
    const result = classifyRedisShakeFailure(null, ['BUSYKEY']);
    expect(result.message).toContain('(exit code unknown)');
    expect(result.message).not.toContain('null');
  });

  it('falls back to UNKNOWN with the exit code when no signature matches', () => {
    const result = classifyRedisShakeFailure(3, ['some unrelated failure']);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('RedisShake exited with code 3');
  });
});
