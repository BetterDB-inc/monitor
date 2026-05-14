import { BadRequestException } from '@nestjs/common';
import { HealthGateService } from '../health-gate.service';
import { MonitorCaptureService } from '../monitor-capture.service';
import { MonitorController } from '../monitor.controller';
import { PreflightService } from '../preflight.service';

describe('MonitorController', () => {
  let controller: MonitorController;
  let captureService: { listSessions: jest.Mock };
  let healthGateService: { evaluate: jest.Mock };
  let preflightService: { run: jest.Mock };

  beforeEach(() => {
    captureService = { listSessions: jest.fn().mockResolvedValue([]) };
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
    controller = new MonitorController(
      captureService as unknown as MonitorCaptureService,
      healthGateService as unknown as HealthGateService,
      preflightService as unknown as PreflightService,
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
});
