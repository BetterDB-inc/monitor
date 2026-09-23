import { HttpException, HttpStatus } from '@nestjs/common';
import { assertOtlpIngestAuthorized } from '../otel-ingest-auth';

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

  it('returns 404 when ingestion is disabled', () => {
    process.env.OTEL_INGEST_ENABLED = 'false';
    expect(statusOf(() => assertOtlpIngestAuthorized(undefined))).toBe(HttpStatus.NOT_FOUND);
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
});
