/* eslint-disable @typescript-eslint/no-explicit-any */
import { BulkDeleteController } from '../bulk-delete.controller';

describe('BulkDeleteController audits limit clamping', () => {
  const makeController = () => {
    const service = { listAudits: jest.fn().mockResolvedValue([]) };
    return { controller: new BulkDeleteController(service as any), service };
  };

  it('clamps a negative limit up to 1 (never reaches storage as -1)', async () => {
    const { controller, service } = makeController();
    await controller.listAudits('conn-1', '-1');
    expect(service.listAudits).toHaveBeenCalledWith('conn-1', 1);
  });

  it('clamps an over-range limit down to 500', async () => {
    const { controller, service } = makeController();
    await controller.listAudits('conn-1', '9999');
    expect(service.listAudits).toHaveBeenCalledWith('conn-1', 500);
  });

  it('passes a valid limit through and defaults to undefined when absent', async () => {
    const { controller, service } = makeController();
    await controller.listAudits('conn-1', '50');
    expect(service.listAudits).toHaveBeenLastCalledWith('conn-1', 50);
    await controller.listAudits('conn-1', undefined);
    expect(service.listAudits).toHaveBeenLastCalledWith('conn-1', undefined);
  });
});
