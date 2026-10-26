import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StoredCaptureSession } from '@betterdb/shared';
import { McpMonitorController, toCaptureSessionSummary } from '../mcp-monitor.controller';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { MonitorCaptureService } from '../../monitor/monitor-capture.service';
import { CrossReferenceEngine } from '../../monitor/cross-reference.engine';

const SESSION_ID = '0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

function session(overrides: Partial<StoredCaptureSession> = {}): StoredCaptureSession {
  return {
    id: SESSION_ID,
    connectionId: 'inst1',
    status: 'completed',
    source: 'manual',
    startedAt: 1_000,
    endedAt: 31_000,
    byteCount: 2048,
    lineCount: 40,
    byteCap: 50 * 1024 * 1024,
    lineCap: 5_000_000,
    terminationReason: 'duration_cap',
    ...overrides,
  };
}

describe('McpMonitorController', () => {
  const capture = { listSessions: jest.fn(), getSession: jest.fn() };
  const engine = { compute: jest.fn() };
  let controller: McpMonitorController;

  beforeEach(async () => {
    jest.clearAllMocks();
    capture.listSessions.mockResolvedValue([session()]);
    capture.getSession.mockResolvedValue(session());
    engine.compute.mockResolvedValue({ sessionId: SESSION_ID, newShapes: [] });
    const mod = await Test.createTestingModule({
      controllers: [McpMonitorController],
      providers: [
        { provide: MonitorCaptureService, useValue: capture },
        { provide: CrossReferenceEngine, useValue: engine },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpMonitorController);
  });

  describe('toCaptureSessionSummary', () => {
    it('projects a finished session and derives durationMs', () => {
      expect(toCaptureSessionSummary(session())).toEqual({
        id: SESSION_ID, status: 'completed', source: 'manual', startedAt: 1_000, endedAt: 31_000,
        durationMs: 30_000, lineCount: 40, byteCount: 2048, terminationReason: 'duration_cap',
        targetNode: null, fanOutNodeCount: 0, triggerId: null, scheduleId: null, requestedBy: null,
      });
    });

    it('reports null end/duration for a running session and counts fan-out nodes', () => {
      const s = session({
        status: 'running',
        endedAt: undefined,
        terminationReason: undefined,
        nodeSegments: [
          { nodeId: 'a', address: 'a:6379', status: 'running', byteCount: 0, lineCount: 0 },
          { nodeId: 'b', address: 'b:6379', status: 'running', byteCount: 0, lineCount: 0 },
        ],
      });
      expect(toCaptureSessionSummary(s)).toMatchObject({ endedAt: null, durationMs: null, terminationReason: null, fanOutNodeCount: 2 });
    });
  });

  describe('listCaptureSessions', () => {
    it('scopes to the path instance with default limit 20', async () => {
      const res = await controller.listCaptureSessions('inst1');
      expect(capture.listSessions).toHaveBeenCalledWith({ connectionId: 'inst1', status: undefined, limit: 20 });
      expect(res.sessions).toHaveLength(1);
      expect(res.sessions[0]).not.toHaveProperty('byteCap');
    });

    it('caps limit at 100 and forwards a valid status', async () => {
      await controller.listCaptureSessions('inst1', '5000', 'truncated');
      expect(capture.listSessions).toHaveBeenCalledWith({ connectionId: 'inst1', status: 'truncated', limit: 100 });
    });

    it('rejects an unknown status', async () => {
      await expect(controller.listCaptureSessions('inst1', undefined, 'done')).rejects.toBeInstanceOf(BadRequestException);
      expect(capture.listSessions).not.toHaveBeenCalled();
    });
  });

  describe('getCaptureCrossReference', () => {
    it('computes with the 24h baseline by default', async () => {
      await controller.getCaptureCrossReference('inst1', SESSION_ID);
      expect(engine.compute).toHaveBeenCalledWith({ sessionId: SESSION_ID, baseline: '24h' });
    });

    it('forwards an explicit baseline', async () => {
      await controller.getCaptureCrossReference('inst1', SESSION_ID, 'same-hour-last-week');
      expect(engine.compute).toHaveBeenCalledWith({ sessionId: SESSION_ID, baseline: 'same-hour-last-week' });
    });

    it('rejects a malformed session id before touching storage', async () => {
      await expect(controller.getCaptureCrossReference('inst1', '../etc')).rejects.toBeInstanceOf(BadRequestException);
      expect(capture.getSession).not.toHaveBeenCalled();
    });

    it('rejects an unknown baseline', async () => {
      await expect(controller.getCaptureCrossReference('inst1', SESSION_ID, '30d')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns 404 when the session does not exist', async () => {
      capture.getSession.mockResolvedValueOnce(null);
      await expect(controller.getCaptureCrossReference('inst1', SESSION_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(engine.compute).not.toHaveBeenCalled();
    });

    it('returns 404 when the session belongs to another instance', async () => {
      capture.getSession.mockResolvedValueOnce(session({ connectionId: 'other' }));
      await expect(controller.getCaptureCrossReference('inst1', SESSION_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(engine.compute).not.toHaveBeenCalled();
    });

    it('maps engine failures to 500', async () => {
      engine.compute.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getCaptureCrossReference('inst1', SESSION_ID)).rejects.toMatchObject({ status: 500 });
    });
  });
});
