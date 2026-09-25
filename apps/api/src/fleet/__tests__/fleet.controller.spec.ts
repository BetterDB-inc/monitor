import { FleetController } from '../fleet.controller';
import { FleetService } from '../fleet.service';

describe('FleetController', () => {
  it('delegates to FleetService.getSummary', async () => {
    const payload = { overallStatus: 'healthy' as const, instances: [], timestamp: 123 };
    const service = { getSummary: jest.fn().mockResolvedValue(payload) } as unknown as FleetService;
    const controller = new FleetController(service);

    await expect(controller.getSummary()).resolves.toBe(payload);
    expect(service.getSummary).toHaveBeenCalledTimes(1);
  });
});
