import {
  CSV_HEADER,
  lineToCsvRow,
  matchesFilters,
  parseMonitorLine,
} from '../monitor-line.parser';

describe('parseMonitorLine', () => {
  it('parses a typical GET line', () => {
    const result = parseMonitorLine('1700000000.123456 [0 127.0.0.1:50000] "GET" "user:42"');
    expect(result).toEqual({
      ts: 1700000000123,
      tsRaw: '1700000000.123456',
      db: 0,
      addr: '127.0.0.1:50000',
      cmd: 'GET',
      args: ['user:42'],
      key: 'user:42',
      raw: '1700000000.123456 [0 127.0.0.1:50000] "GET" "user:42"',
    });
  });

  it('uppercases the command verb', () => {
    expect(parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "set" "k" "v"')?.cmd).toBe('SET');
  });

  it('handles no args (e.g. PING)', () => {
    const r = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "PING"');
    expect(r?.args).toEqual([]);
    expect(r?.key).toBeNull();
  });

  it('handles escaped quotes inside args', () => {
    const r = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "SET" "k" "value with \\"quotes\\""');
    expect(r?.args).toEqual(['k', 'value with "quotes"']);
  });

  it('handles escaped backslashes', () => {
    const r = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "SET" "k" "a\\\\b"');
    expect(r?.args[1]).toBe('a\\b');
  });

  it('parses ipv6-bracketed addresses', () => {
    const r = parseMonitorLine('1700000000.0 [0 [::1]:50000] "PING"');
    expect(r?.addr).toBe('[::1]:50000');
  });

  it('preserves all args in order', () => {
    const r = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "MSET" "k1" "v1" "k2" "v2"');
    expect(r?.args).toEqual(['k1', 'v1', 'k2', 'v2']);
    expect(r?.key).toBe('k1');
  });

  it('returns null for malformed input', () => {
    expect(parseMonitorLine('')).toBeNull();
    expect(parseMonitorLine('not a monitor line')).toBeNull();
    expect(parseMonitorLine('123 [no closing bracket "GET"')).toBeNull();
  });

  it('returns null when the command tokens cannot be parsed', () => {
    expect(parseMonitorLine('1700000000.0 [0 1.2.3.4:5] no-quotes-here')).toBeNull();
  });
});

describe('matchesFilters', () => {
  const sample = parseMonitorLine('1700000000.500 [0 192.168.1.10:6379] "SET" "user:42" "x"')!;

  it('matches when filters are empty', () => {
    expect(matchesFilters(sample, {})).toBe(true);
  });

  describe('command filter', () => {
    it('exact match (case-insensitive)', () => {
      expect(matchesFilters(sample, { command: 'SET' })).toBe(true);
      expect(matchesFilters(sample, { command: 'set' })).toBe(true);
      expect(matchesFilters(sample, { command: 'GET' })).toBe(false);
    });
  });

  describe('client filter', () => {
    it('substring match on addr', () => {
      expect(matchesFilters(sample, { client: '192.168' })).toBe(true);
      expect(matchesFilters(sample, { client: ':6379' })).toBe(true);
      expect(matchesFilters(sample, { client: '10.0' })).toBe(false);
    });
  });

  describe('key filter', () => {
    it('exact glob match', () => {
      expect(matchesFilters(sample, { key: 'user:42' })).toBe(true);
      expect(matchesFilters(sample, { key: 'user:43' })).toBe(false);
    });

    it('star wildcard', () => {
      expect(matchesFilters(sample, { key: 'user:*' })).toBe(true);
      expect(matchesFilters(sample, { key: '*:42' })).toBe(true);
      expect(matchesFilters(sample, { key: 'session:*' })).toBe(false);
    });

    it('question-mark wildcard', () => {
      expect(matchesFilters(sample, { key: 'user:??' })).toBe(true);
      expect(matchesFilters(sample, { key: 'user:?' })).toBe(false);
    });

    it('escapes regex metacharacters in the literal portions', () => {
      const dot = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "GET" "a.b"')!;
      expect(matchesFilters(dot, { key: 'a.b' })).toBe(true);
      expect(matchesFilters(dot, { key: 'aXb' })).toBe(false);
    });

    it('returns false for keyless commands', () => {
      const ping = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "PING"')!;
      expect(matchesFilters(ping, { key: '*' })).toBe(false);
    });
  });

  describe('time window filter', () => {
    it('inclusive lower bound', () => {
      expect(matchesFilters(sample, { afterTs: 1700000000500 })).toBe(true);
      expect(matchesFilters(sample, { afterTs: 1700000000501 })).toBe(false);
    });

    it('inclusive upper bound', () => {
      expect(matchesFilters(sample, { beforeTs: 1700000000500 })).toBe(true);
      expect(matchesFilters(sample, { beforeTs: 1700000000499 })).toBe(false);
    });

    it('combined window', () => {
      expect(matchesFilters(sample, { afterTs: 1700000000400, beforeTs: 1700000000600 })).toBe(true);
      expect(matchesFilters(sample, { afterTs: 1700000000600, beforeTs: 1700000000700 })).toBe(false);
    });
  });

  describe('combined filters (AND semantics)', () => {
    it('all must match', () => {
      expect(matchesFilters(sample, { command: 'SET', client: '192.', key: 'user:*' })).toBe(true);
      expect(matchesFilters(sample, { command: 'GET', client: '192.', key: 'user:*' })).toBe(false);
      expect(matchesFilters(sample, { command: 'SET', client: '10.', key: 'user:*' })).toBe(false);
    });
  });
});

describe('lineToCsvRow', () => {
  it('emits a header that matches the expected column order', () => {
    expect(CSV_HEADER).toBe('ts,ts_raw,db,addr,cmd,args,key');
  });

  it('emits a plain row for fields without special characters', () => {
    const r = parseMonitorLine('1700000000.5 [0 1.2.3.4:5] "GET" "foo"')!;
    expect(lineToCsvRow(r)).toBe('1700000000500,1700000000.5,0,1.2.3.4:5,GET,foo,foo');
  });

  it('quotes and escapes fields containing commas, quotes, or newlines', () => {
    const r = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "SET" "weird,key" "with \\"quote\\""')!;
    const row = lineToCsvRow(r);
    expect(row).toContain('"weird,key"');
    expect(row).toContain('"weird,key with ""quote"""');
  });
});
