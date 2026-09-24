import {
  DEFAULT_SLOT_STATS_TOP_N,
  isExportedInProfile,
  MAX_SLOT_STATS_TOP_N,
  parseExportProfile,
  resolveSlotStatsTopN,
  VITALS_METRICS,
} from './export-profile';

describe('parseExportProfile', () => {
  it('defaults to full', () => {
    expect(parseExportProfile(undefined)).toBe('full');
    expect(parseExportProfile('')).toBe('full');
  });

  it('reads vitals case- and whitespace-insensitively', () => {
    expect(parseExportProfile('vitals')).toBe('vitals');
    expect(parseExportProfile(' VITALS ')).toBe('vitals');
  });

  it('treats anything else as full', () => {
    expect(parseExportProfile('full')).toBe('full');
    expect(parseExportProfile('minimal')).toBe('full');
    expect(parseExportProfile(5000)).toBe('full');
  });
});

describe('resolveSlotStatsTopN', () => {
  it('is zero under vitals whatever is configured', () => {
    expect(resolveSlotStatsTopN('25', 'vitals')).toBe(0);
    expect(resolveSlotStatsTopN(undefined, 'vitals')).toBe(0);
  });

  it('defaults to 100 when unset, blank or not a number', () => {
    expect(resolveSlotStatsTopN(undefined, 'full')).toBe(DEFAULT_SLOT_STATS_TOP_N);
    expect(resolveSlotStatsTopN('  ', 'full')).toBe(DEFAULT_SLOT_STATS_TOP_N);
    expect(resolveSlotStatsTopN('abc', 'full')).toBe(DEFAULT_SLOT_STATS_TOP_N);
  });

  it('reads strings and numbers', () => {
    expect(resolveSlotStatsTopN('25', 'full')).toBe(25);
    expect(resolveSlotStatsTopN(40, 'full')).toBe(40);
    expect(resolveSlotStatsTopN('0', 'full')).toBe(0);
  });

  it('clamps into range and floors fractions', () => {
    expect(resolveSlotStatsTopN('-5', 'full')).toBe(0);
    expect(resolveSlotStatsTopN('99999', 'full')).toBe(MAX_SLOT_STATS_TOP_N);
    expect(resolveSlotStatsTopN('12.9', 'full')).toBe(12);
  });
});

describe('isExportedInProfile', () => {
  it('exports everything under full', () => {
    expect(isExportedInProfile('betterdb_cluster_slot_keys', 'full')).toBe(true);
    expect(isExportedInProfile('betterdb_slowlog_pattern_count', 'full')).toBe(true);
  });

  it('exports only the allowlist under vitals', () => {
    expect(isExportedInProfile('betterdb_memory_used_bytes', 'vitals')).toBe(true);
    expect(isExportedInProfile('betterdb_poll_stale', 'vitals')).toBe(true);
    expect(isExportedInProfile('betterdb_cluster_slot_keys', 'vitals')).toBe(false);
    expect(isExportedInProfile('betterdb_slowlog_pattern_count', 'vitals')).toBe(false);
    expect(isExportedInProfile('betterdb_db_keys', 'vitals')).toBe(false);
  });

  it('allowlists no family that carries a data-derived label', () => {
    for (const name of VITALS_METRICS) {
      expect(name).not.toMatch(/pattern|slot_(keys|expires|reads|writes)|by_(name|user|reason)|^betterdb_db_/);
    }
  });
});
