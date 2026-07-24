import {
  parseScanCommand,
  analyzeScanSkew,
  SCAN_SKEW_BYTES_PER_ELEMENT,
} from '../scan-skew-analyzer';
import { StoredCommandLogEntry } from '../../common/interfaces/storage-port.interface';

const entry = (over: Partial<StoredCommandLogEntry>): StoredCommandLogEntry => {
  return {
    id: 1,
    timestamp: 1_700_000_000,
    duration: 500_000,
    command: ['SSCAN', 'recroom:todo:redo', '3112', 'count', '1024'],
    clientAddress: '127.0.0.1:50000',
    clientName: 'app',
    type: 'large-reply',
    capturedAt: 1_700_000_000_000,
    sourceHost: 'localhost',
    sourcePort: 6379,
    ...over,
  };
};

describe('parseScanCommand', () => {
  it('parses SSCAN with an explicit COUNT', () => {
    expect(parseScanCommand(['SSCAN', 'myset', '0', 'COUNT', '1024'])).toEqual({
      verb: 'SSCAN',
      key: 'myset',
      count: 1024,
    });
  });

  it('parses HSCAN with MATCH before COUNT and a trailing NOVALUES', () => {
    expect(
      parseScanCommand(['HSCAN', 'myhash', '0', 'MATCH', 'f:*', 'COUNT', '500', 'NOVALUES']),
    ).toEqual({ verb: 'HSCAN', key: 'myhash', count: 500 });
  });

  it('parses keyless SCAN with COUNT and TYPE', () => {
    expect(parseScanCommand(['SCAN', '3112', 'COUNT', '64', 'TYPE', 'set'])).toEqual({
      verb: 'SCAN',
      key: null,
      count: 64,
    });
  });

  it('defaults COUNT to 10 when absent', () => {
    expect(parseScanCommand(['SSCAN', 'myset', '0'])).toEqual({
      verb: 'SSCAN',
      key: 'myset',
      count: 10,
    });
  });

  it('is case-insensitive for the verb and keywords', () => {
    expect(parseScanCommand(['sscan', 'myset', '0', 'count', '32'])).toEqual({
      verb: 'SSCAN',
      key: 'myset',
      count: 32,
    });
  });

  it('parses ZSCAN like the other keyed scans', () => {
    expect(parseScanCommand(['ZSCAN', 'myzset', '0', 'COUNT', '100'])).toEqual({
      verb: 'ZSCAN',
      key: 'myzset',
      count: 100,
    });
  });

  it('returns null for non-SCAN-family commands', () => {
    expect(parseScanCommand(['GET', 'bigkey'])).toBeNull();
    expect(parseScanCommand(['HGETALL', 'myhash'])).toBeNull();
  });
});

describe('analyzeScanSkew', () => {
  it('surfaces a key seen twice with reply bytes far above the per-element budget', () => {
    // COUNT 1024 with a 50MB reply → ~48KB per requested element.
    const entries = [
      entry({ id: 1, duration: 50_000_000 }),
      entry({ id: 2, duration: 48_000_000, timestamp: 1_700_000_100 }),
    ];
    const report = analyzeScanSkew(entries);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0].key).toBe('recroom:todo:redo');
    expect(report.offenders[0].sightings).toBe(2);
    expect(report.offenders[0].worstBytesPerElement).toBeGreaterThan(SCAN_SKEW_BYTES_PER_ELEMENT);
    expect(report.offenders[0].message).toContain('valkey#3955');
  });

  it('does not flag a proportional large reply', () => {
    // COUNT 5000 with a 6MB reply → ~1.2KB per requested element: big but proportional.
    const report = analyzeScanSkew([
      entry({ command: ['SSCAN', 'bigset', '0', 'COUNT', '5000'], duration: 6_000_000 }),
      entry({ command: ['SSCAN', 'bigset', '0', 'COUNT', '5000'], duration: 6_000_000, id: 2 }),
    ]);
    expect(report.offenders).toHaveLength(0);
  });

  it('suppresses a single ordinary sighting', () => {
    // Just over budget, seen once → recorded but not surfaced.
    const report = analyzeScanSkew([
      entry({ duration: 1024 * (SCAN_SKEW_BYTES_PER_ELEMENT + 1000) }),
    ]);
    expect(report.offenders).toHaveLength(0);
  });

  it('surfaces a single sighting when the ratio is extreme', () => {
    // COUNT 1 returning ~5MB — the upstream repro class.
    const report = analyzeScanSkew([
      entry({ command: ['SSCAN', 'recroom:todo:redo', '3112', 'COUNT', '1'], duration: 5_000_000 }),
    ]);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0].sightings).toBe(1);
  });

  it('ignores non-SCAN large replies and SCAN entries of other log types', () => {
    const report = analyzeScanSkew([
      entry({ command: ['HGETALL', 'bigkey'], duration: 50_000_000 }),
      entry({ id: 2, type: 'slow', duration: 50_000_000 }),
    ]);
    expect(report.offenders).toHaveLength(0);
  });

  it('ranks offenders worst-first by bytes-per-element', () => {
    const report = analyzeScanSkew([
      entry({ command: ['SSCAN', 'mild', '0', 'COUNT', '100'], duration: 1_000_000, id: 1 }),
      entry({ command: ['SSCAN', 'mild', '0', 'COUNT', '100'], duration: 1_000_000, id: 2 }),
      entry({ command: ['SSCAN', 'severe', '0', 'COUNT', '1'], duration: 5_000_000, id: 3 }),
      entry({ command: ['SSCAN', 'severe', '0', 'COUNT', '1'], duration: 5_000_000, id: 4 }),
    ]);
    expect(report.offenders.map((o) => o.key)).toEqual(['severe', 'mild']);
  });

  it('groups keyless SCAN entries under the scan pattern', () => {
    const report = analyzeScanSkew([
      entry({ command: ['SCAN', '0', 'MATCH', 'sess:*', 'COUNT', '1'], duration: 5_000_000, id: 1 }),
    ]);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0].key).toBe('SCAN sess:*');
  });
});
