import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { LicenseService } from '@proprietary/licenses/license.service';
import { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { CaptureScheduler } from '../../monitor/capture-scheduler';
import { CaptureTriggerRegistry } from '../../monitor/capture-trigger-registry';
import { CrossReferenceEngine } from '../../monitor/cross-reference.engine';
import { HealthGateService } from '../../monitor/health-gate.service';
import { MonitorCaptureService } from '../../monitor/monitor-capture.service';
import { MonitorSupportProbe } from '../../monitor/monitor-support-probe';
import { MonitorController } from '../../monitor/monitor.controller';
import { PreflightService } from '../../monitor/preflight.service';
import { VectorSearchController } from '../../vector-search/vector-search.controller';
import { VectorSearchService } from '../../vector-search/vector-search.service';
import { ExternalConnectionUnsupportedFilter } from '../external-connection-unsupported.filter';

describe('live-only controllers over HTTP with an external connection', () => {
  let app: NestFastifyApplication;
  const configs: Record<string, { connectionType: 'external' | 'direct' }> = {
    'ext-1': { connectionType: 'external' },
    'direct-1': { connectionType: 'direct' },
  };
  const registry = {
    getDefaultId: () => 'direct-1',
    getConfig: (id?: string) => configs[id ?? 'direct-1'] ?? null,
  };
  const vectorSearchService = {
    getIndexList: jest.fn().mockResolvedValue(['idx']),
    getSnapshots: jest.fn().mockResolvedValue([]),
  };
  const captureService = {
    startSession: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
    listSessions: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VectorSearchController, MonitorController],
      providers: [
        { provide: ConnectionRegistry, useValue: registry },
        { provide: VectorSearchService, useValue: vectorSearchService },
        { provide: MonitorCaptureService, useValue: captureService },
        { provide: HealthGateService, useValue: {} },
        { provide: PreflightService, useValue: {} },
        { provide: CrossReferenceEngine, useValue: {} },
        { provide: ClusterDiscoveryService, useValue: {} },
        { provide: CaptureTriggerRegistry, useValue: {} },
        { provide: CaptureScheduler, useValue: {} },
        { provide: MonitorSupportProbe, useValue: {} },
        { provide: 'STORAGE_CLIENT', useValue: {} },
        { provide: LicenseService, useValue: {} },
        { provide: APP_FILTER, useClass: ExternalConnectionUnsupportedFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('answers a vector-search live read with the 501 contract', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/vector-search/indexes',
      headers: { 'x-connection-id': 'ext-1' },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({
      statusCode: 501,
      code: 'EXTERNAL_CONNECTION_UNSUPPORTED',
      method: 'getIndexList',
      message: 'getIndexList is not available for OTLP-ingested connections',
    });
    expect(vectorSearchService.getIndexList).not.toHaveBeenCalled();
  });

  it('keeps serving stored vector-index snapshots for an external connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/vector-search/indexes/idx/snapshots',
      headers: { 'x-connection-id': 'ext-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(vectorSearchService.getSnapshots).toHaveBeenCalledWith('ext-1', 'idx', 24);
  });

  it('refuses a MONITOR session for an external connection before any session is created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/monitor/sessions',
      headers: { 'x-connection-id': 'direct-1' },
      payload: { connectionId: 'ext-1' },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'EXTERNAL_CONNECTION_UNSUPPORTED', method: 'startSession' });
    expect(captureService.startSession).not.toHaveBeenCalled();
  });

  it('still starts a MONITOR session for a direct connection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/monitor/sessions',
      headers: { 'x-connection-id': 'ext-1' },
      payload: { connectionId: 'direct-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(captureService.startSession).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'direct-1' }));
  });

  it('keeps listing stored sessions for an external connection', async () => {
    const res = await app.inject({ method: 'GET', url: '/monitor/sessions?connectionId=ext-1' });

    expect(res.statusCode).toBe(200);
    expect(captureService.listSessions).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ext-1' }));
  });
});
