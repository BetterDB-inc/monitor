import { ScalingReadinessController } from '../scaling-readiness.controller';
import { ENV_DEFAULT_ID } from '../../connections/connection-registry.service';

describe('ScalingReadinessController', () => {
  const compute = jest.fn().mockResolvedValue({ connectionId: 'x' });
  const controller = new ScalingReadinessController({ compute } as any);

  beforeEach(() => compute.mockClear());

  it('computes for the requested connection', async () => {
    await controller.get('conn-1');
    expect(compute).toHaveBeenCalledWith('conn-1');
  });

  it('falls back to the default connection', async () => {
    await controller.get(undefined);
    expect(compute).toHaveBeenCalledWith(ENV_DEFAULT_ID);
  });
});
