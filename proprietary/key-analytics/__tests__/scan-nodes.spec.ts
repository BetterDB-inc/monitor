import { Logger } from '@nestjs/common';
import { clusterScanNodes, primaryScanNodes } from '../scan-nodes';

const logger = { warn: jest.fn() } as unknown as Logger;
const client = (role: string) => ({ getRole: jest.fn().mockResolvedValue({ role }) }) as any;

describe('scan nodes', () => {
  it('adds registered members after the seed and skips unregistered ones', () => {
    const registry = { get: jest.fn((id: string) => { if (id === 'gone') throw new Error('x'); return client('master'); }) } as any;
    const nodes = clusterScanNodes(registry, { name: 'seed', client: client('master') }, [{ id: 'a', name: 'A', membership: { nodeId: 'na' } }, { id: 'gone', name: 'G' }] as any, logger, 'KV cache');
    expect(nodes.map((n) => [n.name, n.connectionId, n.nodeId])).toEqual([['seed', undefined, undefined], ['A', 'a', 'na']]);
  });

  it('keeps primaries only and drops nodes whose role fails', async () => {
    const failing = { getRole: jest.fn().mockRejectedValue(new Error('down')) } as any;
    const nodes = await primaryScanNodes(
      [{ name: 'p', client: client('master') }, { name: 'r', client: client('slave') }, { name: 'f', client: failing }],
      logger,
      'KV cache',
    );
    expect(nodes.map((n) => n.name)).toEqual(['p']);
  });

  it('drops a node whose cluster id an earlier node already reported', async () => {
    const id = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const withId = (myId: unknown) => ({ getRole: jest.fn().mockResolvedValue({ role: 'master' }), call: jest.fn().mockResolvedValue(myId) }) as any;
    const nodes = await primaryScanNodes(
      [
        { name: 'dns-seed', client: withId(id) },
        { name: 'ip-member', client: withId(id), connectionId: 'm1', nodeId: 'stale' },
        { name: 'other', client: withId(other), connectionId: 'm2' },
        { name: 'no-id', client: withId('junk') },
        { name: 'no-call', client: client('master') },
      ],
      logger,
      'KV cache',
    );
    expect(nodes.map((n) => [n.name, n.nodeId])).toEqual([['dns-seed', id], ['other', other], ['no-id', undefined], ['no-call', undefined]]);
  });
});
