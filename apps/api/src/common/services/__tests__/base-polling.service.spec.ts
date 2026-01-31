import { Logger } from '@nestjs/common';
import { BasePollingService, PollingLoop } from '../base-polling.service';

// Concrete implementation for testing
class TestPollingService extends BasePollingService {
  protected readonly logger = new Logger('TestPollingService');

  // Expose protected methods for testing
  public startLoop(loop: PollingLoop): void {
    this.startPollingLoop(loop);
  }

  public stopLoop(name: string): void {
    this.stopPollingLoop(name);
  }

  public stopAll(): void {
    this.stopAllPollingLoops();
  }

  public getActiveLoops(): string[] {
    return this.getActivePollingLoops();
  }

  public isLoopActive(name: string): boolean {
    return this.isPollingLoopActive(name);
  }

  public isLoopBusy(name: string): boolean {
    return this.isPollingLoopBusy(name);
  }
}

describe('BasePollingService', () => {
  let service: TestPollingService;

  beforeEach(() => {
    service = new TestPollingService();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('startPollingLoop', () => {
    it('should start a polling loop and run initial poll', async () => {
      const pollFn = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn,
      });

      // Initial poll runs immediately
      await jest.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);

      // Advance time and check subsequent polls
      await jest.advanceTimersByTimeAsync(1000);
      expect(pollFn).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1000);
      expect(pollFn).toHaveBeenCalledTimes(3);
    });

    it('should skip initial poll when initialPoll is false', async () => {
      const pollFn = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn,
        initialPoll: false,
      });

      // No immediate poll
      await jest.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(0);

      // First poll after interval
      await jest.advanceTimersByTimeAsync(1000);
      expect(pollFn).toHaveBeenCalledTimes(1);
    });

    it('should support dynamic intervals', async () => {
      const pollFn = jest.fn().mockResolvedValue(undefined);
      let interval = 1000;

      service.startLoop({
        name: 'test',
        getIntervalMs: () => interval,
        poll: pollFn,
        initialPoll: false,
      });

      // First poll at 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      expect(pollFn).toHaveBeenCalledTimes(1);

      // Change interval
      interval = 2000;

      // Next poll should use new interval
      await jest.advanceTimersByTimeAsync(2000);
      expect(pollFn).toHaveBeenCalledTimes(2);
    });

    it('should not start duplicate loops with the same name', () => {
      const pollFn1 = jest.fn().mockResolvedValue(undefined);
      const pollFn2 = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn1,
        initialPoll: false,
      });

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn2,
        initialPoll: false,
      });

      // Only one loop should be active
      expect(service.getActiveLoops()).toHaveLength(1);
    });

    it('should handle poll errors gracefully', async () => {
      const pollFn = jest.fn()
        .mockRejectedValueOnce(new Error('Test error'))
        .mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn,
      });

      // Initial poll throws error
      await jest.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);

      // Loop continues despite error
      await jest.advanceTimersByTimeAsync(1000);
      expect(pollFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrency protection', () => {
    it('should track busy state while poll is running', async () => {
      let resolveSlowPoll: () => void;
      const slowPoll = new Promise<void>(resolve => {
        resolveSlowPoll = resolve;
      });

      const pollFn = jest.fn().mockImplementation(() => slowPoll);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 100,
        poll: pollFn,
        initialPoll: true,
      });

      // Initial poll starts - should be busy
      await jest.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);
      expect(service.isLoopBusy('test')).toBe(true);

      // Resolve the slow poll
      resolveSlowPoll!();
      await jest.advanceTimersByTimeAsync(0);
      expect(service.isLoopBusy('test')).toBe(false);
    });
  });

  describe('stopPollingLoop', () => {
    it('should stop a specific polling loop', async () => {
      const pollFn = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn,
        initialPoll: false,
      });

      expect(service.isLoopActive('test')).toBe(true);

      service.stopLoop('test');

      expect(service.isLoopActive('test')).toBe(false);
      expect(service.getActiveLoops()).toHaveLength(0);
    });
  });

  describe('stopAllPollingLoops', () => {
    it('should stop all active loops', async () => {
      const pollFn1 = jest.fn().mockResolvedValue(undefined);
      const pollFn2 = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'loop1',
        getIntervalMs: () => 1000,
        poll: pollFn1,
        initialPoll: false,
      });

      service.startLoop({
        name: 'loop2',
        getIntervalMs: () => 2000,
        poll: pollFn2,
        initialPoll: false,
      });

      expect(service.getActiveLoops()).toHaveLength(2);

      service.stopAll();

      expect(service.getActiveLoops()).toHaveLength(0);
    });
  });

  describe('multiple loops', () => {
    it('should support multiple independent polling loops', async () => {
      const pollFn1 = jest.fn().mockResolvedValue(undefined);
      const pollFn2 = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'loop1',
        getIntervalMs: () => 1000,
        poll: pollFn1,
        initialPoll: false,
      });

      service.startLoop({
        name: 'loop2',
        getIntervalMs: () => 2000,
        poll: pollFn2,
        initialPoll: false,
      });

      // Both loops should be registered
      expect(service.getActiveLoops()).toHaveLength(2);
      expect(service.isLoopActive('loop1')).toBe(true);
      expect(service.isLoopActive('loop2')).toBe(true);

      // Stop one loop
      service.stopLoop('loop1');
      expect(service.getActiveLoops()).toHaveLength(1);
      expect(service.isLoopActive('loop1')).toBe(false);
      expect(service.isLoopActive('loop2')).toBe(true);
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up all loops on destroy', async () => {
      const pollFn = jest.fn().mockResolvedValue(undefined);

      service.startLoop({
        name: 'test',
        getIntervalMs: () => 1000,
        poll: pollFn,
        initialPoll: false,
      });

      expect(service.getActiveLoops()).toHaveLength(1);

      await service.onModuleDestroy();

      expect(service.getActiveLoops()).toHaveLength(0);
    });
  });
});
