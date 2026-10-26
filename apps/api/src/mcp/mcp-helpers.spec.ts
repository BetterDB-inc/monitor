import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CapabilityUnavailableError } from '../common/errors/capability-unavailable.error';
import { ExternalConnectionUnsupportedError } from '../external-metrics/external-connection-unsupported.error';
import {
  DAY_MS,
  HOUR_MS,
  MAX_DB_INDEX,
  mapMcpError,
  parseOptionalDbIndex,
  redactScrapeUrl,
  redactUrlCredentials,
  resolveTimeRange,
} from './mcp-helpers';

describe('mapMcpError', () => {
  let logger: jest.Mocked<Logger>;

  beforeEach(() => {
    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>;
  });

  it('rethrows ExternalConnectionUnsupportedError unchanged without logging', () => {
    const error = new ExternalConnectionUnsupportedError('getInfo');

    expect(() => {
      throw mapMcpError(logger, error, 'Failed to get info');
    }).toThrow(error);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns the original HttpException unchanged', () => {
    const error = new HttpException('bad request', HttpStatus.BAD_REQUEST);

    expect(mapMcpError(logger, error, 'fallback')).toBe(error);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps CapabilityUnavailableError to 501', () => {
    const error = new CapabilityUnavailableError('not available');

    const result = mapMcpError(logger, error, 'fallback');

    expect(result.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(result.message).toBe('not available');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and maps unknown errors to 500', () => {
    const error = new Error('boom');

    const result = mapMcpError(logger, error, 'fallback', 'log message');

    expect(result.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.message).toBe('fallback');
    expect(logger.error).toHaveBeenCalledWith('log message', error.stack);
  });
});

describe('resolveTimeRange', () => {
  const NOW = 1_700_000_000_000;

  it('defaults to [now - lookback, now] when both bounds are missing', () => {
    expect(resolveTimeRange(undefined, undefined, DAY_MS, 7 * DAY_MS, NOW)).toEqual({ from: NOW - DAY_MS, to: NOW });
  });

  it('treats blank strings as missing', () => {
    expect(resolveTimeRange(' ', '', DAY_MS, 7 * DAY_MS, NOW)).toEqual({ from: NOW - DAY_MS, to: NOW });
  });

  it('anchors the default lookback on an explicit endTime', () => {
    expect(resolveTimeRange(undefined, String(NOW - HOUR_MS), HOUR_MS, DAY_MS, NOW)).toEqual({ from: NOW - 2 * HOUR_MS, to: NOW - HOUR_MS });
  });

  it('never defaults below zero', () => {
    expect(resolveTimeRange(undefined, '1000', DAY_MS, 7 * DAY_MS, NOW)).toEqual({ from: 0, to: 1000 });
  });

  it('passes explicit bounds through unchanged', () => {
    expect(resolveTimeRange('1000', '2000', DAY_MS, DAY_MS, NOW)).toEqual({ from: 1000, to: 2000 });
  });

  it.each([
    ['abc', '2000'],
    ['1000.5', '2000'],
    ['1000', 'Infinity'],
  ])('rejects non-integer bounds (%s, %s)', (start, end) => {
    expect(() => resolveTimeRange(start, end, DAY_MS, DAY_MS, NOW)).toThrow(BadRequestException);
  });

  it('rejects negative bounds', () => {
    expect(() => resolveTimeRange('-1', '2000', DAY_MS, DAY_MS, NOW)).toThrow(BadRequestException);
  });

  it('rejects an inverted range', () => {
    expect(() => resolveTimeRange('3000', '2000', DAY_MS, DAY_MS, NOW)).toThrow('startTime must be less than or equal to endTime');
  });

  it('rejects a range wider than maxSpanMs', () => {
    expect(() => resolveTimeRange('0', String(2 * DAY_MS), DAY_MS, DAY_MS, NOW)).toThrow('time range must not exceed 24 hours');
  });

  it('accepts a range exactly maxSpanMs wide', () => {
    expect(resolveTimeRange('0', String(DAY_MS), DAY_MS, DAY_MS, NOW)).toEqual({ from: 0, to: DAY_MS });
  });
});

describe('parseOptionalDbIndex', () => {
  it('returns undefined for missing or blank input', () => {
    expect(parseOptionalDbIndex(undefined)).toBeUndefined();
    expect(parseOptionalDbIndex('')).toBeUndefined();
  });

  it('parses valid indexes', () => {
    expect(parseOptionalDbIndex('0')).toBe(0);
    expect(parseOptionalDbIndex('15')).toBe(15);
  });

  it.each(['-1', '1.5', 'abc', String(MAX_DB_INDEX + 1)])('rejects %s', (value) => {
    expect(() => parseOptionalDbIndex(value)).toThrow(BadRequestException);
  });
});

describe('redactUrlCredentials', () => {
  it('strips userinfo from every embedded URL', () => {
    expect(redactUrlCredentials('GET http://u:p@a:9000/metrics failed; retry https://tok@b/x')).toBe('GET http://a:9000/metrics failed; retry https://b/x');
  });

  it('leaves text without credentials untouched', () => {
    expect(redactUrlCredentials('connect ECONNREFUSED 10.0.0.1:9000')).toBe('connect ECONNREFUSED 10.0.0.1:9000');
  });
});

describe('redactScrapeUrl', () => {
  it('returns null for null', () => {
    expect(redactScrapeUrl(null)).toBeNull();
  });

  it('drops userinfo, query and fragment', () => {
    expect(redactScrapeUrl('https://user:secret@vllm.internal:8000/metrics?token=abc#x')).toBe('https://vllm.internal:8000/metrics');
  });

  it('keeps a clean URL as-is', () => {
    expect(redactScrapeUrl('http://vllm:8000/metrics')).toBe('http://vllm:8000/metrics');
  });

  it('falls back to regex redaction for unparseable values', () => {
    expect(redactScrapeUrl('not a url?token=1')).toBe('not a url');
  });
});
