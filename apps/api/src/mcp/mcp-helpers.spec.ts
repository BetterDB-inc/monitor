import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CapabilityUnavailableError } from '../common/errors/capability-unavailable.error';
import { ExternalConnectionUnsupportedError } from '../external-metrics/external-connection-unsupported.error';
import {
  DAY_MS,
  DEFAULT_MAX_POINTS,
  HOUR_MS,
  MAX_DB_INDEX,
  downsampleEvenly,
  downsampleSeries,
  mapMcpError,
  parseMaxPoints,
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

  it('strips the whole userinfo when the password contains a literal @', () => {
    expect(redactUrlCredentials('GET http://user:p@ss@host:9000/metrics -> 401')).toBe('GET http://host:9000/metrics -> 401');
  });

  it('does not span past a path, query or fragment', () => {
    expect(redactUrlCredentials('http://host/a@b and https://u:p@c/x')).toBe('http://host/a@b and https://c/x');
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

  it('falls back safely for an unparseable URL with @ in the password', () => {
    expect(redactScrapeUrl('http://u:p@ss@ host/x?t=1')).not.toContain('ss@');
  });
});

describe('parseMaxPoints', () => {
  it('defaults to 150 when blank or missing', () => {
    expect(parseMaxPoints(undefined)).toBe(DEFAULT_MAX_POINTS);
    expect(parseMaxPoints('')).toBe(150);
    expect(parseMaxPoints('  ')).toBe(150);
  });

  it('accepts the bounds', () => {
    expect(parseMaxPoints('2')).toBe(2);
    expect(parseMaxPoints('1000')).toBe(1000);
  });

  it.each(['1', '1001', '1.5', 'abc', '-5', '0'])('rejects %s with 400', (value) => {
    expect(() => parseMaxPoints(value)).toThrow(BadRequestException);
  });
});

describe('downsampleEvenly', () => {
  it('returns a copy unchanged when within the budget', () => {
    const input = [1, 2, 3];
    const out = downsampleEvenly(input, 5);
    expect(out).toEqual([1, 2, 3]);
    expect(out).not.toBe(input);
  });

  it('thins 1,440 points to 150, keeping first, last and only original elements', () => {
    const input = Array.from({ length: 1440 }, (_, i) => ({ t: i }));
    const out = downsampleEvenly(input, 150);
    expect(out).toHaveLength(150);
    expect(out[0]).toBe(input[0]);
    expect(out[149]).toBe(input[1439]);
    for (const point of out) {
      expect(input).toContain(point);
    }
    const times = out.map((point) => point.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('downsampleSeries', () => {
  const engines = ['e1', 'e2', 'e3'];
  const models = ['m1', 'm2'];
  const rows = engines.flatMap((engineId) => {
    return models.flatMap((model) => {
      return Array.from({ length: 1440 }, (_, t) => ({ engineId, model, t }));
    });
  });
  const key = (row: { engineId: string; model: string; t: number }) => `${row.engineId}|${row.model}`;

  it('splits the budget across series and reports sampling', () => {
    const { rows: out, sampling } = downsampleSeries(rows, key, 150);
    expect(out).toHaveLength(150);
    expect(sampling).toEqual({ originalPoints: 8640, returnedPoints: 150, maxPoints: 150, method: 'even' });
    for (const engineId of engines) {
      for (const model of models) {
        const series = out.filter((row) => row.engineId === engineId && row.model === model);
        expect(series).toHaveLength(25);
        expect(series[0].t).toBe(0);
        expect(series[24].t).toBe(1439);
      }
    }
  });

  it('reports method none when nothing is dropped', () => {
    const small = rows.filter((row) => row.t < 3);
    const { rows: out, sampling } = downsampleSeries(small, key, 150);
    expect(out).toHaveLength(small.length);
    expect(sampling.method).toBe('none');
  });

  it('keeps the last point of the first maxPoints series when there are more series than maxPoints', () => {
    const many = Array.from({ length: 10 }, (_, s) => {
      return Array.from({ length: 50 }, (_, t) => ({ s: `s${s}`, t }));
    }).flat();
    const { rows: out, sampling } = downsampleSeries(many, (row) => row.s, 6);
    expect(out).toHaveLength(6);
    expect(out.map((row) => row.s)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(out.every((row) => row.t === 49)).toBe(true);
    expect(sampling.omittedSeries).toBe(4);
    expect(sampling.method).toBe('even');
  });

  it('keeps one latest point per series when the share is 1', () => {
    const few = Array.from({ length: 5 }, (_, s) => {
      return Array.from({ length: 50 }, (_, t) => ({ s: `s${s}`, t }));
    }).flat();
    const { rows: out, sampling } = downsampleSeries(few, (row) => row.s, 6);
    expect(out).toHaveLength(5);
    expect(out.every((row) => row.t === 49)).toBe(true);
    expect(sampling.omittedSeries).toBeUndefined();
  });

  it('never returns more than maxPoints in total', () => {
    for (const maxPoints of [2, 3, 7, 150]) {
      for (let seriesCount = 1; seriesCount <= 40; seriesCount++) {
        const data = Array.from({ length: seriesCount }, (_, s) => {
          const length = 1 + Math.floor(Math.random() * 300);
          return Array.from({ length }, (_, t) => ({ s: `s${s}`, t }));
        }).flat();
        const { rows: out } = downsampleSeries(data, (row) => row.s, maxPoints);
        expect(out.length).toBeLessThanOrEqual(maxPoints);
      }
    }
  });
});
