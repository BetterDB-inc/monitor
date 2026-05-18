import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { MonitorSupportProbe } from '../monitor-support-probe';

interface MakeProbeOptions {
  callImpl: (cmd: string, args: string[]) => Promise<unknown>;
  monitorImpl?: () => Promise<{ disconnect: jest.Mock }>;
  clientStatus?: string;
}

function makeProbe({ callImpl, monitorImpl, clientStatus = 'ready' }: MakeProbeOptions) {
  const call = jest.fn().mockImplementation(callImpl);
  const monitorMock = monitorImpl ? jest.fn().mockImplementation(monitorImpl) : undefined;
  const port: Record<string, unknown> = { call };
  if (monitorMock) {
    port.getClient = jest.fn().mockReturnValue({ status: clientStatus, monitor: monitorMock });
  }
  const registry = {
    get: jest.fn().mockReturnValue(port),
  } as unknown as ConnectionRegistry;
  return { probe: new MonitorSupportProbe(registry), call, monitorMock };
}

describe('MonitorSupportProbe', () => {
  describe('layer 1: COMMAND INFO MONITOR', () => {
    it('returns status=yes with source=command-info when COMMAND INFO MONITOR returns a command entry', async () => {
      const { probe } = makeProbe({
        callImpl: async () => [['monitor', 1, ['admin', 'noscript']]],
      });
      const result = await probe.probe('conn-1');
      expect(result.status).toBe('yes');
      expect(result.source).toBe('command-info');
      expect(result.checkedAt).toBeGreaterThan(0);
    });

    it('returns status=no with source=command-info when COMMAND INFO MONITOR returns [nil]', async () => {
      const { probe } = makeProbe({ callImpl: async () => [null] });
      const result = await probe.probe('conn-1');
      expect(result.status).toBe('no');
      expect(result.source).toBe('command-info');
      expect(result.detail).toMatch(/nil/i);
    });

    it('does not invoke the live MONITOR probe when COMMAND INFO is definitive', async () => {
      const { probe, monitorMock } = makeProbe({
        callImpl: async () => [['monitor', 1]],
        monitorImpl: async () => ({ disconnect: jest.fn() }),
      });
      await probe.probe('conn-1');
      expect(monitorMock).not.toHaveBeenCalled();
    });
  });

  describe('layer 2: live MONITOR fallback', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('escalates to live MONITOR when COMMAND INFO errors, and returns yes when MONITOR resolves', async () => {
      const disconnect = jest.fn();
      const { probe, monitorMock } = makeProbe({
        callImpl: async () => {
          throw new Error('ERR wrong number of arguments for command');
        },
        monitorImpl: async () => ({ disconnect }),
      });

      const pending = probe.probe('conn-1');
      await jest.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(monitorMock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('yes');
      expect(result.source).toBe('live-monitor');
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('returns status=no with source=live-monitor when MONITOR is rejected by a still-connected server', async () => {
      const { probe } = makeProbe({
        callImpl: async () => {
          throw new Error('ERR wrong number of arguments');
        },
        monitorImpl: async () => {
          throw new Error('NOPERM MONITOR is not allowed');
        },
        clientStatus: 'ready',
      });
      const result = await probe.probe('conn-1');
      expect(result.status).toBe('no');
      expect(result.source).toBe('live-monitor');
      expect(result.detail).toContain('NOPERM');
    });

    it('returns status=unknown when MONITOR rejects and the parent client is no longer ready', async () => {
      const { probe } = makeProbe({
        callImpl: async () => {
          throw new Error('ERR cmd');
        },
        monitorImpl: async () => {
          throw new Error('ECONNRESET');
        },
        clientStatus: 'end',
      });
      const result = await probe.probe('conn-1');
      expect(result.status).toBe('unknown');
      expect(result.source).toBe('live-monitor');
    });

    it('escalates on empty COMMAND INFO array', async () => {
      const disconnect = jest.fn();
      const { probe, monitorMock } = makeProbe({
        callImpl: async () => [],
        monitorImpl: async () => ({ disconnect }),
      });

      const pending = probe.probe('conn-1');
      await jest.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(monitorMock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('yes');
    });

    it('escalates on unexpected COMMAND INFO shape', async () => {
      const disconnect = jest.fn();
      const { probe, monitorMock } = makeProbe({
        callImpl: async () => 'OK',
        monitorImpl: async () => ({ disconnect }),
      });

      const pending = probe.probe('conn-1');
      await jest.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(monitorMock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('yes');
    });

  });

  describe('getCached', () => {
    it('returns undefined before any probe has run', () => {
      const { probe } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      expect(probe.getCached('conn-1')).toBeUndefined();
    });

    it('returns the cached verdict after probe() has run', async () => {
      const { probe } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      await probe.probe('conn-1');
      const cached = probe.getCached('conn-1');
      expect(cached?.status).toBe('yes');
      expect(cached?.source).toBe('command-info');
    });

    it('does not trigger a probe — call() must not be invoked', () => {
      const { probe, call } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      probe.getCached('conn-1');
      probe.getCached('conn-1');
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('caches a layer-1 verdict across calls', async () => {
      const { probe, call } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      await probe.probe('conn-1');
      await probe.probe('conn-1');
      await probe.probe('conn-1');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('caches a layer-2 verdict so the live probe runs only once', async () => {
      jest.useFakeTimers();
      const disconnect = jest.fn();
      const { probe, call, monitorMock } = makeProbe({
        callImpl: async () => {
          throw new Error('ERR');
        },
        monitorImpl: async () => ({ disconnect }),
      });

      const first = probe.probe('conn-1');
      await jest.advanceTimersByTimeAsync(100);
      await first;
      await probe.probe('conn-1');
      await probe.probe('conn-1');

      expect(call).toHaveBeenCalledTimes(1);
      expect(monitorMock).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('probes again after invalidate(connectionId)', async () => {
      const { probe, call } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      await probe.probe('conn-1');
      probe.invalidate('conn-1');
      await probe.probe('conn-1');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('caches separately per connectionId', async () => {
      const { probe, call } = makeProbe({ callImpl: async () => [['monitor', 1]] });
      await probe.probe('conn-1');
      await probe.probe('conn-2');
      expect(call).toHaveBeenCalledTimes(2);
    });
  });

});
