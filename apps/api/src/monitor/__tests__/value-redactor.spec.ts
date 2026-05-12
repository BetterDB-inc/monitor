import {
  REDACTED_PLACEHOLDER,
  isRedactionEnabled,
  redactWriteCommandArgs,
} from '../value-redactor';

describe('redactWriteCommandArgs', () => {
  it('returns args untouched for an unknown verb', () => {
    expect(redactWriteCommandArgs(['GET', 'foo'])).toEqual(['GET', 'foo']);
  });

  it('returns the empty array unchanged', () => {
    expect(redactWriteCommandArgs([])).toEqual([]);
  });

  it('SET key value → value redacted', () => {
    expect(redactWriteCommandArgs(['SET', 'foo', 'bar'])).toEqual([
      'SET',
      'foo',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('SET preserves trailing options like EX/NX/XX/GET while redacting the value', () => {
    expect(redactWriteCommandArgs(['SET', 'foo', 'bar', 'EX', '60', 'NX'])).toEqual([
      'SET',
      'foo',
      REDACTED_PLACEHOLDER,
      'EX',
      '60',
      'NX',
    ]);
  });

  it('SETEX/PSETEX redact the value at the trailing position', () => {
    expect(redactWriteCommandArgs(['SETEX', 'k', '30', 'v'])).toEqual([
      'SETEX',
      'k',
      '30',
      REDACTED_PLACEHOLDER,
    ]);
    expect(redactWriteCommandArgs(['PSETEX', 'k', '3000', 'v'])).toEqual([
      'PSETEX',
      'k',
      '3000',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('SETNX, GETSET, APPEND redact the value at index 1', () => {
    for (const verb of ['SETNX', 'GETSET', 'APPEND']) {
      expect(redactWriteCommandArgs([verb, 'k', 'v'])).toEqual([
        verb,
        'k',
        REDACTED_PLACEHOLDER,
      ]);
    }
  });

  it('LSET redacts the value at index 2 (after key + index)', () => {
    expect(redactWriteCommandArgs(['LSET', 'k', '0', 'v'])).toEqual([
      'LSET',
      'k',
      '0',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('LINSERT redacts both pivot and value', () => {
    expect(redactWriteCommandArgs(['LINSERT', 'k', 'BEFORE', 'p', 'v'])).toEqual([
      'LINSERT',
      'k',
      'BEFORE',
      REDACTED_PLACEHOLDER,
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('MSET redacts every value in the key/value stream', () => {
    expect(redactWriteCommandArgs(['MSET', 'k1', 'v1', 'k2', 'v2', 'k3', 'v3'])).toEqual([
      'MSET',
      'k1',
      REDACTED_PLACEHOLDER,
      'k2',
      REDACTED_PLACEHOLDER,
      'k3',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('HSET redacts every value but keeps field names', () => {
    expect(
      redactWriteCommandArgs(['HSET', 'h', 'f1', 'v1', 'f2', 'v2']),
    ).toEqual(['HSET', 'h', 'f1', REDACTED_PLACEHOLDER, 'f2', REDACTED_PLACEHOLDER]);
  });

  it('HMSET behaves like HSET (deprecated alias)', () => {
    expect(redactWriteCommandArgs(['HMSET', 'h', 'f', 'v'])).toEqual([
      'HMSET',
      'h',
      'f',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('HSETNX redacts only the single value', () => {
    expect(redactWriteCommandArgs(['HSETNX', 'h', 'f', 'v'])).toEqual([
      'HSETNX',
      'h',
      'f',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('LPUSH/RPUSH/LPUSHX/RPUSHX redact every value after the key', () => {
    for (const verb of ['LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX']) {
      expect(redactWriteCommandArgs([verb, 'k', 'a', 'b', 'c'])).toEqual([
        verb,
        'k',
        REDACTED_PLACEHOLDER,
        REDACTED_PLACEHOLDER,
        REDACTED_PLACEHOLDER,
      ]);
    }
  });

  it('SADD/SREM redact every member after the key', () => {
    for (const verb of ['SADD', 'SREM']) {
      expect(redactWriteCommandArgs([verb, 's', 'a', 'b'])).toEqual([
        verb,
        's',
        REDACTED_PLACEHOLDER,
        REDACTED_PLACEHOLDER,
      ]);
    }
  });

  it('PUBLISH/SPUBLISH redact the message argument', () => {
    expect(redactWriteCommandArgs(['PUBLISH', 'ch', 'hi'])).toEqual([
      'PUBLISH',
      'ch',
      REDACTED_PLACEHOLDER,
    ]);
    expect(redactWriteCommandArgs(['SPUBLISH', 'ch', 'hi'])).toEqual([
      'SPUBLISH',
      'ch',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('verb match is case-insensitive', () => {
    expect(redactWriteCommandArgs(['set', 'k', 'v'])).toEqual([
      'set',
      'k',
      REDACTED_PLACEHOLDER,
    ]);
  });

  it('does not touch read commands', () => {
    expect(redactWriteCommandArgs(['HGETALL', 'h'])).toEqual(['HGETALL', 'h']);
    expect(redactWriteCommandArgs(['MGET', 'k1', 'k2'])).toEqual(['MGET', 'k1', 'k2']);
  });

  it('handles a SET with only a key (defensive — not a valid Redis call)', () => {
    expect(redactWriteCommandArgs(['SET', 'k'])).toEqual(['SET', 'k']);
  });
});

describe('isRedactionEnabled', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.MONITOR_REDACT_VALUES;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.MONITOR_REDACT_VALUES;
    } else {
      process.env.MONITOR_REDACT_VALUES = original;
    }
  });

  it('returns false when the env is unset', () => {
    delete process.env.MONITOR_REDACT_VALUES;
    expect(isRedactionEnabled()).toBe(false);
  });

  it('returns true only on the literal string "true"', () => {
    process.env.MONITOR_REDACT_VALUES = 'true';
    expect(isRedactionEnabled()).toBe(true);
    process.env.MONITOR_REDACT_VALUES = '1';
    expect(isRedactionEnabled()).toBe(false);
    process.env.MONITOR_REDACT_VALUES = 'TRUE';
    expect(isRedactionEnabled()).toBe(false);
  });
});
