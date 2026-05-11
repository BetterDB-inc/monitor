import { BadRequestException } from '@nestjs/common';
import { HealthGateService } from '../health-gate.service';
import { MonitorCaptureService } from '../monitor-capture.service';
import { MonitorController } from '../monitor.controller';

describe('MonitorController', () => {
  let controller: MonitorController;
  let captureService: { listSessions: jest.Mock };
  let healthGateService: { evaluate: jest.Mock };

  beforeEach(() => {
    captureService = { listSessions: jest.fn().mockResolvedValue([]) };
    healthGateService = {
      evaluate: jest.fn().mockResolvedValue({ allow: true, signals: {}, thresholds: {} }),
    };
    controller = new MonitorController(
      captureService as unknown as MonitorCaptureService,
      healthGateService as unknown as HealthGateService,
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
});
