import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import { CaptureScheduler } from '../capture-scheduler';
import { CaptureTriggerRegistry } from '../capture-trigger-registry';
import { CrossReferenceEngine } from '../cross-reference.engine';
import { HealthGateService } from '../health-gate.service';
import { MonitorCaptureService } from '../monitor-capture.service';
import { MonitorController } from '../monitor.controller';
import { PreflightService } from '../preflight.service';

describe('MonitorController', () => {
  let controller: MonitorController;
  let captureService: {
    listSessions: jest.Mock;
    startSession: jest.Mock;
    stopSession: jest.Mock;
    getSession: jest.Mock;
  };
  let healthGateService: { evaluate: jest.Mock };
  let preflightService: { run: jest.Mock };
  let storage: { getCaptureChunks: jest.Mock };
  let crossReferenceEngine: { compute: jest.Mock };
  let clusterDiscovery: { discoverNodes: jest.Mock };
  let triggerRegistry: {
    listTriggers: jest.Mock;
    createTrigger: jest.Mock;
    cancelTrigger: jest.Mock;
  };
  let captureScheduler: {
    listSchedules: jest.Mock;
    createSchedule: jest.Mock;
    deleteSchedule: jest.Mock;
  };

  beforeEach(() => {
    captureService = {
      listSessions: jest.fn().mockResolvedValue([]),
      startSession: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
      stopSession: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'completed' }),
      getSession: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
    };
    healthGateService = {
      evaluate: jest.fn().mockResolvedValue({ allow: true, signals: {}, thresholds: {} }),
    };
    preflightService = {
      run: jest.fn().mockResolvedValue({
        connectionId: 'conn-1',
        provider: { provider: 'self-hosted', restrictions: [] },
        acl: { username: 'default', hasMonitor: true },
        health: { allow: true, signals: {}, thresholds: {} },
        throughput: {
          opsPerSec: 0,
          inputKbps: 0,
          outputKbps: 0,
          durationMs: 30000,
          estimatedLines: 0,
          estimatedBytes: 0,
        },
      }),
    };
    storage = { getCaptureChunks: jest.fn().mockResolvedValue([]) };
    clusterDiscovery = { discoverNodes: jest.fn().mockResolvedValue([]) };
    crossReferenceEngine = {
      compute: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        baseline: { window: '24h', startTs: 0, endTs: 0 },
        session: { startTs: 0, endTs: 0, capturedLineCount: 0 },
        newShapes: [],
        hotKeyDelta: { newInTopK: [], rankChanges: [] },
        slowlogRegressions: [],
        aclDeltas: { auditEntriesInWindow: 0, counters: { aclAccessDeniedAuthDelta: null, rejectedConnectionsDelta: null } },
      }),
    };
    triggerRegistry = {
      listTriggers: jest.fn().mockResolvedValue([]),
      createTrigger: jest.fn().mockResolvedValue({ id: 'trig-1', status: 'configured' }),
      cancelTrigger: jest.fn().mockResolvedValue(true),
    };
    captureScheduler = {
      listSchedules: jest.fn().mockResolvedValue([]),
      createSchedule: jest.fn().mockResolvedValue({ id: 'sched-1', status: 'enabled' }),
      deleteSchedule: jest.fn().mockResolvedValue(true),
    };
    controller = new MonitorController(
      captureService as unknown as MonitorCaptureService,
      healthGateService as unknown as HealthGateService,
      preflightService as unknown as PreflightService,
      crossReferenceEngine as unknown as CrossReferenceEngine,
      clusterDiscovery as unknown as ClusterDiscoveryService,
      triggerRegistry as unknown as CaptureTriggerRegistry,
      captureScheduler as unknown as CaptureScheduler,
      storage as unknown as StoragePort,
    );
  });

  describe('ping', () => {
    it('returns { ok: true }', () => {
      expect(controller.ping()).toEqual({ ok: true });
    });
  });

  describe('listSessions', () => {
    it('returns an empty array when the connection has no sessions', async () => {
      await expect(controller.listSessions('conn-1')).resolves.toEqual([]);
      expect(captureService.listSessions).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        limit: 100,
        offset: 0,
      });
    });

    it('throws BadRequest when connectionId is missing', () => {
      expect(() => controller.listSessions()).toThrow(BadRequestException);
      expect(captureService.listSessions).not.toHaveBeenCalled();
    });

    it('forwards connectionId / limit / offset to the service', async () => {
      await controller.listSessions('conn-1', '10', '20');
      expect(captureService.listSessions).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        limit: 10,
        offset: 20,
      });
    });

    it('falls back to defaults for non-numeric limit/offset', async () => {
      await controller.listSessions('conn-1', 'abc', '-5');
      expect(captureService.listSessions).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        limit: 100,
        offset: 0,
      });
    });
  });

  describe('evaluateHealthGate', () => {
    it('forwards connectionId to the service', async () => {
      await controller.evaluateHealthGate('conn-1');
      expect(healthGateService.evaluate).toHaveBeenCalledWith('conn-1');
    });

    it('throws BadRequest when connectionId is missing', async () => {
      await expect(controller.evaluateHealthGate(undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(healthGateService.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('preflight', () => {
    it('forwards connectionId and durationMs to the service', async () => {
      await controller.preflight({ connectionId: 'conn-1', durationMs: 60_000 });
      expect(preflightService.run).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        durationMs: 60_000,
      });
    });

    it('throws BadRequest when connectionId is missing', async () => {
      await expect(controller.preflight({})).rejects.toBeInstanceOf(BadRequestException);
      expect(preflightService.run).not.toHaveBeenCalled();
    });
  });

  describe('startSession', () => {
    it('forwards connectionId and optional caps / duration to the service', async () => {
      await controller.startSession({
        connectionId: 'conn-1',
        durationMs: 5000,
        byteCap: 1234,
        lineCap: 567,
        requestedBy: 'tester',
      });
      expect(captureService.startSession).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        durationMs: 5000,
        byteCap: 1234,
        lineCap: 567,
        requestedBy: 'tester',
        targetNodeId: undefined,
      });
    });

    it('forwards targetNodeId when supplied', async () => {
      await controller.startSession({ connectionId: 'conn-1', targetNodeId: 'node-7' });
      expect(captureService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ targetNodeId: 'node-7' }),
      );
    });

    it('throws BadRequest when connectionId is missing', async () => {
      await expect(controller.startSession({})).rejects.toBeInstanceOf(BadRequestException);
      expect(captureService.startSession).not.toHaveBeenCalled();
    });
  });

  describe('listConnectionNodes', () => {
    it('returns {isCluster:false, nodes:[]} when discovery finds no nodes', async () => {
      clusterDiscovery.discoverNodes.mockResolvedValueOnce([]);
      const result = await controller.listConnectionNodes('conn-1');
      expect(result).toEqual({ isCluster: false, nodes: [] });
    });

    it('returns descriptor list with isCluster:true when nodes exist', async () => {
      clusterDiscovery.discoverNodes.mockResolvedValueOnce([
        { id: 'a', address: 'h1:6379', role: 'master', slots: [[0, 5460]], healthy: true },
        { id: 'b', address: 'h2:6379', role: 'replica', masterId: 'a', slots: [], healthy: true },
      ]);
      const result = await controller.listConnectionNodes('conn-1');
      expect(result.isCluster).toBe(true);
      expect(result.nodes).toEqual([
        { id: 'a', address: 'h1:6379', role: 'master', healthy: true },
        { id: 'b', address: 'h2:6379', role: 'replica', healthy: true },
      ]);
    });

    it('treats a non-cluster connection (discovery throws) as {isCluster:false}', async () => {
      clusterDiscovery.discoverNodes.mockRejectedValueOnce(new Error('CLUSTER not supported'));
      const result = await controller.listConnectionNodes('conn-1');
      expect(result).toEqual({ isCluster: false, nodes: [] });
    });
  });

  describe('getSession', () => {
    it('returns the session record', async () => {
      const result = await controller.getSession('sess-1');
      expect(result).toMatchObject({ id: 'sess-1' });
      expect(captureService.getSession).toHaveBeenCalledWith('sess-1');
    });

    it('throws NotFound when the session does not exist', async () => {
      captureService.getSession.mockResolvedValueOnce(null);
      await expect(controller.getSession('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('stopSession', () => {
    it('returns the updated session record', async () => {
      const result = await controller.stopSession('sess-1');
      expect(result).toMatchObject({ id: 'sess-1', status: 'completed' });
      expect(captureService.stopSession).toHaveBeenCalledWith('sess-1');
    });

    it('throws NotFound when the session does not exist', async () => {
      captureService.stopSession.mockResolvedValueOnce(null);
      await expect(controller.stopSession('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('crossReference', () => {
    it('forwards the sessionId and the default 24h baseline to the engine', async () => {
      await controller.crossReference('sess-1');
      expect(crossReferenceEngine.compute).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        baseline: '24h',
      });
    });

    it('honors explicit baseline windows', async () => {
      for (const window of ['6h', '24h', '7d', 'same-hour-last-week']) {
        await controller.crossReference('sess-1', window);
        expect(crossReferenceEngine.compute).toHaveBeenLastCalledWith({
          sessionId: 'sess-1',
          baseline: window,
        });
      }
    });

    it('throws BadRequest for an unknown baseline value', async () => {
      await expect(controller.crossReference('sess-1', '15m')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(crossReferenceEngine.compute).not.toHaveBeenCalled();
    });

    it('throws NotFound when the session does not exist', async () => {
      captureService.getSession.mockResolvedValueOnce(null);
      await expect(controller.crossReference('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(crossReferenceEngine.compute).not.toHaveBeenCalled();
    });
  });

  describe('exportSession', () => {
    function makeReply() {
      const reply = {
        status: jest.fn(),
        header: jest.fn(),
        send: jest.fn(),
      };
      reply.status.mockReturnValue(reply);
      reply.header.mockReturnValue(reply);
      return reply;
    }

    function chunkOf(lines: string[]) {
      return {
        sessionId: 'sess-1',
        chunkIndex: 0,
        bytes: Buffer.from(lines.join('\n'), 'utf-8'),
        lineCount: lines.length,
        firstTs: 0,
        lastTs: 0,
      };
    }

    it('throws NotFound when the session does not exist', async () => {
      captureService.getSession.mockResolvedValueOnce(null);
      await expect(
        controller.exportSession('missing', 'json', undefined, undefined, undefined, undefined, undefined, makeReply() as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns JSON with all parsed lines when no filters are set', async () => {
      storage.getCaptureChunks.mockResolvedValueOnce([
        chunkOf([
          '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
          '1700000000.5 [0 1.2.3.4:5] "SET" "bar" "v"',
        ]),
      ]);
      const reply = makeReply();
      await controller.exportSession('sess-1', 'json', undefined, undefined, undefined, undefined, undefined, reply as never);

      expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
      expect(reply.header).toHaveBeenCalledWith(
        'content-disposition',
        expect.stringContaining('monitor-session-sess-1.json'),
      );
      const body = reply.send.mock.calls[0][0];
      expect(body.count).toBe(2);
      expect(body.lines.map((l: { cmd: string }) => l.cmd)).toEqual(['GET', 'SET']);
    });

    it('respects the command filter', async () => {
      storage.getCaptureChunks.mockResolvedValueOnce([
        chunkOf([
          '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
          '1700000000.5 [0 1.2.3.4:5] "SET" "bar" "v"',
        ]),
      ]);
      const reply = makeReply();
      await controller.exportSession('sess-1', 'json', 'SET', undefined, undefined, undefined, undefined, reply as never);
      const body = reply.send.mock.calls[0][0];
      expect(body.count).toBe(1);
      expect(body.lines[0].cmd).toBe('SET');
    });

    it('emits CSV with header row when format=csv', async () => {
      storage.getCaptureChunks.mockResolvedValueOnce([
        chunkOf(['1700000000.0 [0 1.2.3.4:5] "GET" "foo"']),
      ]);
      const reply = makeReply();
      await controller.exportSession('sess-1', 'csv', undefined, undefined, undefined, undefined, undefined, reply as never);
      expect(reply.header).toHaveBeenCalledWith('content-type', 'text/csv; charset=utf-8');
      expect(reply.header).toHaveBeenCalledWith(
        'content-disposition',
        expect.stringContaining('monitor-session-sess-1.csv'),
      );
      const body = reply.send.mock.calls[0][0];
      expect(body.split('\n')[0]).toBe('ts,ts_raw,db,addr,cmd,args,key');
      expect(body).toContain('GET,foo,foo');
    });

    it('defaults format to json when an unknown value is supplied', async () => {
      storage.getCaptureChunks.mockResolvedValueOnce([]);
      const reply = makeReply();
      await controller.exportSession('sess-1', 'xml', undefined, undefined, undefined, undefined, undefined, reply as never);
      expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
    });
  });

  describe('triggers', () => {
    it('listTriggers forwards query params to the registry', async () => {
      await controller.listTriggers('conn-1', 'configured', '50', '10');
      expect(triggerRegistry.listTriggers).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        status: 'configured',
        limit: 50,
        offset: 10,
      });
    });

    it('createTrigger forwards body fields and returns the new trigger', async () => {
      const result = await controller.createTrigger({
        connectionId: 'conn-1',
        metricType: 'connections',
        anomalyType: 'spike',
        createdBy: 'alice',
      });
      expect(triggerRegistry.createTrigger).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        metricType: 'connections',
        anomalyType: 'spike',
        expiresAt: undefined,
        createdBy: 'alice',
      });
      expect(result).toEqual({ id: 'trig-1', status: 'configured' });
    });

    it('createTrigger throws BadRequest when connectionId is missing', async () => {
      await expect(
        controller.createTrigger({ metricType: 'connections', anomalyType: 'spike' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createTrigger throws BadRequest when metricType is missing', async () => {
      await expect(
        controller.createTrigger({ connectionId: 'conn-1', anomalyType: 'spike' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createTrigger throws BadRequest when anomalyType is missing', async () => {
      await expect(
        controller.createTrigger({ connectionId: 'conn-1', metricType: 'connections' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancelTrigger returns { cancelled: true } when the registry accepts', async () => {
      const result = await controller.cancelTrigger('trig-1');
      expect(triggerRegistry.cancelTrigger).toHaveBeenCalledWith('trig-1');
      expect(result).toEqual({ cancelled: true });
    });

    it('cancelTrigger throws NotFound when the trigger cannot be cancelled', async () => {
      triggerRegistry.cancelTrigger.mockResolvedValueOnce(false);
      await expect(controller.cancelTrigger('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('schedules', () => {
    it('listSchedules forwards query params to the scheduler', async () => {
      await controller.listSchedules('conn-1', 'enabled', '50', '10');
      expect(captureScheduler.listSchedules).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        status: 'enabled',
        limit: 50,
        offset: 10,
      });
    });

    it('createSchedule forwards body fields and returns the new schedule', async () => {
      const result = await controller.createSchedule({
        connectionId: 'conn-1',
        intervalSeconds: 30,
        durationMs: 5000,
        createdBy: 'alice',
      });
      expect(captureScheduler.createSchedule).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        intervalSeconds: 30,
        cronExpression: undefined,
        durationMs: 5000,
        createdBy: 'alice',
      });
      expect(result).toEqual({ id: 'sched-1', status: 'enabled' });
    });

    it('createSchedule throws BadRequest when connectionId is missing', async () => {
      await expect(
        controller.createSchedule({ intervalSeconds: 30, durationMs: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createSchedule throws BadRequest when both intervalSeconds and cronExpression are missing', async () => {
      await expect(
        controller.createSchedule({ connectionId: 'conn-1', durationMs: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createSchedule forwards cronExpression when provided', async () => {
      await controller.createSchedule({
        connectionId: 'conn-1',
        cronExpression: '*/2 * * * *',
        durationMs: 5000,
      });
      expect(captureScheduler.createSchedule).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        intervalSeconds: undefined,
        cronExpression: '*/2 * * * *',
        durationMs: 5000,
        createdBy: undefined,
      });
    });

    it('createSchedule throws BadRequest when durationMs is missing', async () => {
      await expect(
        controller.createSchedule({ connectionId: 'conn-1', intervalSeconds: 30 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deleteSchedule returns { deleted: true } when the scheduler accepts', async () => {
      const result = await controller.deleteSchedule('sched-1');
      expect(captureScheduler.deleteSchedule).toHaveBeenCalledWith('sched-1');
      expect(result).toEqual({ deleted: true });
    });

    it('deleteSchedule throws NotFound when the scheduler reports no row', async () => {
      captureScheduler.deleteSchedule.mockResolvedValueOnce(false);
      await expect(controller.deleteSchedule('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
