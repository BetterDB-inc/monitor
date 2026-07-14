import { HttpException, HttpStatus } from '@nestjs/common';
import { OtelIngestController } from '../otel-ingest.controller';
import type { OtelIngestService } from '../otel-ingest.service';

function makeController() {
  const ingest = { ingest: jest.fn(async () => ({ stored: 0 })) };
  const ctrl = new OtelIngestController(ingest as unknown as OtelIngestService);
  return { ctrl, ingest };
}

describe('OtelIngestController.ingestTraces', () => {
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

  it('accepts anonymous spans when self-hosted with no token', async () => {
    const { ctrl, ingest } = makeController();
    await ctrl.ingestTraces({}, undefined);
    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('fails closed in cloud mode when OTEL_INGEST_TOKEN is unset', async () => {
    process.env.CLOUD_MODE = 'true';
    const { ctrl, ingest } = makeController();
    await expect(ctrl.ingestTraces({}, undefined)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('accepts a valid bearer token in cloud mode', async () => {
    process.env.CLOUD_MODE = 'true';
    process.env.OTEL_INGEST_TOKEN = 'secret';
    const { ctrl, ingest } = makeController();
    await ctrl.ingestTraces({}, 'Bearer secret');
    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid bearer token when a token is configured', async () => {
    process.env.OTEL_INGEST_TOKEN = 'secret';
    const { ctrl, ingest } = makeController();
    await expect(ctrl.ingestTraces({}, 'Bearer wrong')).rejects.toBeInstanceOf(HttpException);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('returns 404 when ingestion is disabled', async () => {
    process.env.OTEL_INGEST_ENABLED = 'false';
    const { ctrl } = makeController();
    await expect(ctrl.ingestTraces({}, undefined)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });
});
