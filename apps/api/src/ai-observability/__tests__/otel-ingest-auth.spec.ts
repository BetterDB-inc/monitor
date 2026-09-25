import { timingSafeEqual } from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { assertOtlpIngestAuthorized } from '../otel-ingest-auth';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

describe('assertOtlpIngestAuthorized', () => {
  const ENV_KEYS = ['OTEL_INGEST_ENABLED', 'OTEL_INGEST_TOKEN', 'CLOUD_MODE'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  const statusOf = (fn: () => void): number | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof HttpException ? err.getStatus() : -1;
    }
  };

  it('allows anonymous ingestion self-hosted without a token', () => {
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBeNull();
  });

  it.each(['false', '0', ' FALSE ', '0\n', 'no', 'off'])('returns 404 when ingestion is disabled with %j', (value) => {
    process.env.OTEL_INGEST_ENABLED = value;
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBe(HttpStatus.NOT_FOUND);
  });

  it.each(['true', '1', ''])('keeps ingestion enabled with %j', (value) => {
    process.env.OTEL_INGEST_ENABLED = value;
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBeNull();
  });

  it('fails closed in cloud mode without a token', () => {
    process.env.CLOUD_MODE = 'true';
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('requires the configured bearer token', () => {
    process.env.OTEL_INGEST_TOKEN = 's3cret';
    expect(statusOf(() => assertOtlpIngestAuthorized('Bearer nope'))).toBe(HttpStatus.UNAUTHORIZED);
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBe(HttpStatus.UNAUTHORIZED);
    expect(statusOf(() => assertOtlpIngestAuthorized('Bearer s3cret'))).toBeNull();
  });

  it('rejects tokens that only share a prefix with the configured one', () => {
    process.env.OTEL_INGEST_TOKEN = 's3cret';
    expect(statusOf(() => assertOtlpIngestAuthorized('Bearer s3cre'))).toBe(HttpStatus.UNAUTHORIZED);
    expect(statusOf(() => assertOtlpIngestAuthorized('Bearer s3cretX'))).toBe(
      HttpStatus.UNAUTHORIZED,
    );
    expect(statusOf(() => assertOtlpIngestAuthorized('s3cret'))).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('compares the bearer token in constant time', () => {
    process.env.OTEL_INGEST_TOKEN = 's3cret';
    (timingSafeEqual as jest.Mock).mockClear();

    assertOtlpIngestAuthorized('Bearer s3cret');

    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
