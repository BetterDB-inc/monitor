import { HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OtelIngestController } from '../otel-ingest.controller';
import type { OtelIngestService } from '../otel-ingest.service';

function makeCtrl() {
  const ingest = {
    ingest: jest.fn(async () => ({ stored: 0, received: 0 })),
  } as unknown as OtelIngestService & { ingest: jest.Mock };
  return { ctrl: new OtelIngestController(ingest), ingest };
}

function fakeReply() {
  return { header: jest.fn() } as unknown as FastifyReply;
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

  // --- response encoding ---

  it('returns JSON {} for a JSON request (no content-type override)', async () => {
    const { ctrl } = makeCtrl();
    const reply = fakeReply();
    const res = await ctrl.ingestTraces(reply, { resourceSpans: [] }, 'application/json');
    expect(res).toEqual({});
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('returns an empty protobuf body + content-type for a protobuf request', async () => {
    const { ctrl } = makeCtrl();
    const reply = fakeReply();
    const res = await ctrl.ingestTraces(reply, Buffer.alloc(0), 'application/x-protobuf');
    expect(Buffer.isBuffer(res)).toBe(true);
    expect((res as Buffer).length).toBe(0);
    expect(reply.header).toHaveBeenCalledWith('content-type', 'application/x-protobuf');
  });

  it('rejects a protobuf content-type whose body is not a buffer', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/x-protobuf'),
    ).rejects.toBeTruthy();
  });

  // --- auth ---

  it('accepts anonymous spans when self-hosted with no token', async () => {
    const { ctrl, ingest } = makeCtrl();
    await ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json');
    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('fails closed in cloud mode when OTEL_INGEST_TOKEN is unset', async () => {
    process.env.CLOUD_MODE = 'true';
    const { ctrl, ingest } = makeCtrl();
    await expect(
      ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json'),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('treats CLOUD_MODE=false as self-hosted (no token required)', async () => {
    process.env.CLOUD_MODE = 'false'; // truthy string, but not the cloud sentinel
    const { ctrl, ingest } = makeCtrl();
    await ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json');
    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid bearer token in cloud mode', async () => {
    process.env.CLOUD_MODE = 'true';
    process.env.OTEL_INGEST_TOKEN = 'secret';
    const { ctrl, ingest } = makeCtrl();
    await ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json', 'Bearer secret');
    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid bearer token when a token is configured', async () => {
    process.env.OTEL_INGEST_TOKEN = 'secret';
    const { ctrl, ingest } = makeCtrl();
    await expect(
      ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json', 'Bearer wrong'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('returns 404 when ingestion is disabled', async () => {
    process.env.OTEL_INGEST_ENABLED = 'false';
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.ingestTraces(fakeReply(), { resourceSpans: [] }, 'application/json'),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});
