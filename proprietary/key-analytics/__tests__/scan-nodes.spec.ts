import { Logger } from '@nestjs/common';
import { clusterScanNodes, primaryScanNodes } from '../scan-nodes';

const logger = { warn: jest.fn() } as unknown as Logger;
const client = (role: string) => ({ getRole: jest.fn().mockResolvedValue({ role }) }) as any;

describe('scan nodes', () => {
  it('adds registered members after the seed and skips unregistered ones', () => {
    const registry = { get: jest.fn((id: string) => { if (id === 'gone') throw new Error('x'); return client('master'); }) } as any;
    const nodes = clusterScanNodes(registry, { name: 'seed', client: client('master') }, [{ id: 'a', name: 'A' }, { id: 'gone', name: 'G' }] as any, logger, 'KV cache');
    expect(nodes.map((n) => n.name)).toEqual(['seed', 'A']);
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
});
