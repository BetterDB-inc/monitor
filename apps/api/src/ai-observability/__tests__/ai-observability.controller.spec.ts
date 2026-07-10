import { HttpException } from '@nestjs/common';
import { AiObservabilityController } from '../ai-observability.controller';
import type { AiObservabilityService, AiInstanceWithSample } from '../ai-observability.service';
import type { TraceCorrelationService } from '../trace-correlation.service';

function makeController(
  svc: Partial<AiObservabilityService>,
  correlation: Partial<TraceCorrelationService> = {},
) {
  return new AiObservabilityController(
    svc as AiObservabilityService,
    correlation as TraceCorrelationService,
  );
}

describe('AiObservabilityController', () => {
  it('returns discovered instances', async () => {
    const instances: AiInstanceWithSample[] = [
      {
        instance: {
          field: 'app',
          kind: 'agent_cache',
          name: 'app',
          version: '1',
          capabilities: [],
          alive: true,
        },
        latest: null,
      },
    ];
    const ctrl = makeController({ getInstances: jest.fn(async () => instances) });

    const res = await ctrl.getInstances('c1');

    expect(res.instances).toBe(instances);
  });

  it('defaults history window to 24h and clamps invalid input', async () => {
    const getHistory = jest.fn(async () => []);
    const ctrl = makeController({ getHistory });

    await ctrl.getHistory('app', undefined, 'c1');
    expect(getHistory).toHaveBeenLastCalledWith('c1', 'app', 24);

    await ctrl.getHistory('app', '0', 'c1'); // invalid → falls back to 24
    expect(getHistory).toHaveBeenLastCalledWith('c1', 'app', 24);

    await ctrl.getHistory('app', '6', 'c1');
    expect(getHistory).toHaveBeenLastCalledWith('c1', 'app', 6);

    await ctrl.getHistory('app', '100000', 'c1'); // huge → clamped to 168h
    expect(getHistory).toHaveBeenLastCalledWith('c1', 'app', 168);
  });

  it('maps service errors to HttpException', async () => {
    const ctrl = makeController({
      getInstances: jest.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(ctrl.getInstances('c1')).rejects.toBeInstanceOf(HttpException);
  });
});
