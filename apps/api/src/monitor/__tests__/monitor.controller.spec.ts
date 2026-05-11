import { MonitorController } from '../monitor.controller';

describe('MonitorController', () => {
  let controller: MonitorController;

  beforeEach(() => {
    controller = new MonitorController();
  });

  describe('ping', () => {
    it('returns { ok: true }', () => {
      expect(controller.ping()).toEqual({ ok: true });
    });
  });
});
