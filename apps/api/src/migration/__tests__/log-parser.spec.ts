import { parseLogLine } from '../execution/log-parser';

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
