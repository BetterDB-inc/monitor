import { HttpException, HttpStatus } from '@nestjs/common';
import { ConnectionsController } from '../connections.controller';
import { ConnectionRegistry } from '../connection-registry.service';
import {
  CAPABILITY_TEST_COMMAND,
  RuntimeCapabilityTracker,
} from '../runtime-capability-tracker.service';

interface AdapterStub {
  call: jest.Mock;
}

interface SetupOptions {
  callImpl?: (...args: unknown[]) => Promise<unknown>;
  hasConfig?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const adapter: AdapterStub = {
    call: jest.fn().mockImplementation(opts.callImpl ?? (async () => 'OK')),
  };
  const registry = {
    getConfig: jest.fn().mockReturnValue(opts.hasConfig === false ? undefined : { id: 'conn-1' }),
    get: jest.fn().mockReturnValue(adapter),
  } as unknown as ConnectionRegistry;
  const tracker = new RuntimeCapabilityTracker();
  const controller = new ConnectionsController(registry, tracker);
  return { controller, registry, tracker, adapter };
}

describe('ConnectionsController.retryCapability', () => {
  describe('argument validation', () => {
    it('rejects an unknown capability key with 400', async () => {
      const { controller } = setup();
      await expect(controller.retryCapability('conn-1', 'canTimeTravel')).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('returns 404 when the connection is unknown', async () => {
      const { controller } = setup({ hasConfig: false });
      await expect(controller.retryCapability('missing', 'canSlowLog')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('success — probe accepts the command', () => {
    it('returns { available: true } and re-enables the capability', async () => {
      const { controller, tracker } = setup({ callImpl: async () => 0 });
      // Pre-disable to prove the call re-enables it.
      tracker.recordFailure('conn-1', 'canSlowLog', new Error("ERR unknown command 'SLOWLOG'"));
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(false);

      const result = await controller.retryCapability('conn-1', 'canSlowLog');

      expect(result).toEqual({ available: true });
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(true);
      expect(tracker.getDisabledReasons('conn-1').canSlowLog).toBeUndefined();
    });

    it('sends the command + args from CAPABILITY_TEST_COMMAND', async () => {
      const { controller, adapter } = setup();
      await controller.retryCapability('conn-1', 'canClusterSlotStats');
      const [command, ...args] = CAPABILITY_TEST_COMMAND.canClusterSlotStats;
      expect(adapter.call).toHaveBeenCalledWith(command, args);
    });
  });

  describe('blocked-pattern failure — probe rejected by server', () => {
    it('returns { available: false, reason } and records the failure', async () => {
      const { controller, tracker } = setup({
        callImpl: async () => {
          throw new Error("ERR Command is not available: 'SLOWLOG'");
        },
      });

      const result = await controller.retryCapability('conn-1', 'canSlowLog');

      expect(result).toEqual({
        available: false,
        reason: "ERR Command is not available: 'SLOWLOG'",
      });
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(false);
      expect(tracker.getDisabledReasons('conn-1').canSlowLog?.reason).toBe(
        "ERR Command is not available: 'SLOWLOG'",
      );
    });

    it('classifies "cluster support disabled" as a definitive rejection', async () => {
      const { controller, tracker } = setup({
        callImpl: async () => {
          throw new Error('ERR This instance has cluster support disabled');
        },
      });

      const result = await controller.retryCapability('conn-1', 'canClusterSlotStats');

      expect(result.available).toBe(false);
      expect(tracker.isAvailable('conn-1', 'canClusterSlotStats')).toBe(false);
    });
  });

  describe('transient failure — non-blocked error', () => {
    it('returns { available: "unknown", reason } and leaves capability state untouched', async () => {
      const { controller, tracker } = setup({
        callImpl: async () => {
          throw new Error('ECONNRESET');
        },
      });
      // Ensure no prior recorded state.
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(true);

      const result = await controller.retryCapability('conn-1', 'canSlowLog');

      expect(result).toEqual({ available: 'unknown', reason: 'ECONNRESET' });
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(true);
      expect(tracker.getDisabledReasons('conn-1').canSlowLog).toBeUndefined();
    });

    it('preserves a previously-disabled state on transient errors', async () => {
      const { controller, tracker } = setup({
        callImpl: async () => {
          throw new Error('Connection timeout');
        },
      });
      tracker.recordFailure(
        'conn-1',
        'canSlowLog',
        new Error("ERR Command is not available: 'SLOWLOG'"),
      );

      const result = await controller.retryCapability('conn-1', 'canSlowLog');

      expect(result.available).toBe('unknown');
      // Still disabled — transient failure must not re-enable.
      expect(tracker.isAvailable('conn-1', 'canSlowLog')).toBe(false);
    });
  });

  describe('non-Error rejection values', () => {
    it('handles string rejections', async () => {
      const { controller } = setup({
        callImpl: async () => {
          throw 'plain-string-error';
        },
      });
      const result = await controller.retryCapability('conn-1', 'canSlowLog');
      expect(result.available).toBe('unknown');
      expect(result.reason).toBe('plain-string-error');
    });
  });
});

describe('ConnectionsController.retryCapability — HttpException shapes', () => {
  it('uses HttpException so Nest maps it to a JSON error body', async () => {
    const { controller } = setup();
    try {
      await controller.retryCapability('conn-1', 'canMagic');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
    }
  });
});
