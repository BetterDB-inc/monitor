import { MonitorCaptureService } from '../monitor-capture.service';
import { MonitorController } from '../monitor.controller';

describe('MonitorController', () => {
  let controller: MonitorController;
  let captureService: { listSessions: jest.Mock };

  beforeEach(() => {
    captureService = { listSessions: jest.fn().mockResolvedValue([]) };
    controller = new MonitorController(captureService as unknown as MonitorCaptureService);
  });

  describe('ping', () => {
    it('returns { ok: true }', () => {
      expect(controller.ping()).toEqual({ ok: true });
    });
  });

  describe('listSessions', () => {
    it('returns an empty array when there are no sessions', async () => {
      await expect(controller.listSessions()).resolves.toEqual([]);
      expect(captureService.listSessions).toHaveBeenCalledWith({
        connectionId: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('forwards connectionId / limit / offset to the service', async () => {
      await controller.listSessions('conn-1', '10', '20');
      expect(captureService.listSessions).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        limit: 10,
        offset: 20,
      });
    });
  });
});
