import { DiscoveryReaderService } from '../discovery-reader.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';

type CallFn = (cmd: string, args: string[]) => Promise<unknown> | unknown;

function makeRegistry(call: CallFn): ConnectionRegistry {
  return {
    get: jest.fn(() => ({ call })),
  } as unknown as ConnectionRegistry;
}

function marker(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'agent_cache',
    prefix: 'app',
    version: '0.1.0',
    protocol_version: 1,
    ...overrides,
  });
}

describe('DiscoveryReaderService.discover', () => {
  it('returns every known kind with heartbeat liveness', async () => {
    const registryReply = [
      'app', marker({ type: 'agent_cache', prefix: 'app', stats_key: 'app:__stats' }),
      'app_sc', marker({ type: 'semantic_cache', prefix: 'app_sc', index_name: 'app_sc:idx' }),
      'app:mem', marker({ type: 'agent_memory', prefix: 'app', index_name: 'app:mem:idx' }),
      'docs', marker({ type: 'retrieval', prefix: 'docs', index_name: 'docs:idx' }),
    ];
    const call: CallFn = (cmd, args) => {
      if (cmd === 'HGETALL') return registryReply;
      if (cmd === 'GET') {
        // app_sc has no live heartbeat; everything else does.
        return args[0] === '__betterdb:heartbeat:app_sc' ? null : '2026-07-10T00:00:00.000Z';
      }
      return null;
    };
    const svc = new DiscoveryReaderService(makeRegistry(call));

    const instances = await svc.discover('c1');

    expect(instances).toHaveLength(4);
    const byField = Object.fromEntries(instances.map((i) => [i.field, i]));
    expect(byField['app'].kind).toBe('agent_cache');
    expect(byField['app'].alive).toBe(true);
    expect(byField['app'].lastHeartbeat).toBe('2026-07-10T00:00:00.000Z');
    expect(byField['app:mem'].kind).toBe('agent_memory');
    expect(byField['app:mem'].name).toBe('app');
    expect(byField['app:mem'].indexName).toBe('app:mem:idx');
    expect(byField['app_sc'].alive).toBe(false);
    expect(byField['app_sc'].lastHeartbeat).toBeUndefined();
  });

  it('skips malformed markers and unknown types', async () => {
    const reply = [
      'good', marker({ type: 'semantic_cache', prefix: 'good' }),
      'notjson', 'this is not json',
      'wrongtype', JSON.stringify({ type: 'some_other_thing', prefix: 'x' }),
      'nofields', JSON.stringify({ version: '1' }),
    ];
    const call: CallFn = (cmd) => (cmd === 'HGETALL' ? reply : 'ts');
    const svc = new DiscoveryReaderService(makeRegistry(call));

    const instances = await svc.discover('c1');

    expect(instances).toHaveLength(1);
    expect(instances[0].field).toBe('good');
    expect(instances[0].kind).toBe('semantic_cache');
  });

  it('parses an object-shaped HGETALL reply', async () => {
    const reply = { app: marker({ type: 'agent_cache', prefix: 'app' }) };
    const call: CallFn = (cmd) => (cmd === 'HGETALL' ? reply : 'ts');
    const svc = new DiscoveryReaderService(makeRegistry(call));

    const instances = await svc.discover('c1');

    expect(instances).toHaveLength(1);
    expect(instances[0].kind).toBe('agent_cache');
    expect(instances[0].alive).toBe(true);
  });

  it('returns [] when the registry read fails', async () => {
    const call: CallFn = (cmd) => {
      if (cmd === 'HGETALL') throw new Error('WRONGTYPE');
      return null;
    };
    const svc = new DiscoveryReaderService(makeRegistry(call));

    await expect(svc.discover('c1')).resolves.toEqual([]);
  });

  it('returns [] on an empty registry', async () => {
    const call: CallFn = () => [];
    const svc = new DiscoveryReaderService(makeRegistry(call));

    await expect(svc.discover('c1')).resolves.toEqual([]);
  });
});
