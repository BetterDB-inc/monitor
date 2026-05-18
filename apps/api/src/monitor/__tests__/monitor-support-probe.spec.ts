import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { MonitorSupportProbe } from '../monitor-support-probe';

function makeProbe(
  callImpl: (cmd: string, args: string[]) => Promise<unknown>,
) {
  const call = jest.fn().mockImplementation(callImpl);
  const registry = {
    get: jest.fn().mockReturnValue({ call }),
  } as unknown as ConnectionRegistry;
  return { probe: new MonitorSupportProbe(registry), call, registry };
}

describe('MonitorSupportProbe', () => {
  it('returns status=yes when COMMAND INFO MONITOR returns a command entry', async () => {
    const { probe } = makeProbe(async () => [['monitor', 1, ['admin', 'noscript']]]);
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('yes');
    expect(result.checkedAt).toBeGreaterThan(0);
  });

  it('returns status=no when COMMAND INFO MONITOR returns [nil]', async () => {
    const { probe } = makeProbe(async () => [null]);
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('no');
    expect(result.detail).toMatch(/nil/i);
  });

  it('returns status=unknown when COMMAND itself errors', async () => {
    const { probe } = makeProbe(async () => {
      throw new Error('ERR unknown command');
    });
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('unknown');
    expect(result.detail).toContain('unknown command');
  });

  it('returns status=unknown for an empty top-level array', async () => {
    const { probe } = makeProbe(async () => []);
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('unknown');
  });

  it('returns status=unknown for unexpected shape', async () => {
    const { probe } = makeProbe(async () => 'OK');
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('unknown');
  });

  it('caches the result across calls for the same connection', async () => {
    const { probe, call } = makeProbe(async () => [['monitor', 1]]);
    await probe.probe('conn-1');
    await probe.probe('conn-1');
    await probe.probe('conn-1');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('probes again after invalidate(connectionId)', async () => {
    const { probe, call } = makeProbe(async () => [['monitor', 1]]);
    await probe.probe('conn-1');
    probe.invalidate('conn-1');
    await probe.probe('conn-1');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('caches separately per connectionId', async () => {
    const { probe, call } = makeProbe(async () => [['monitor', 1]]);
    await probe.probe('conn-1');
    await probe.probe('conn-2');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('returns status=unknown when the client lacks a call() method', async () => {
    const registry = {
      get: jest.fn().mockReturnValue({}),
    } as unknown as ConnectionRegistry;
    const probe = new MonitorSupportProbe(registry);
    const result = await probe.probe('conn-1');
    expect(result.status).toBe('unknown');
    expect(result.detail).toMatch(/call\(/);
  });
});
