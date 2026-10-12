import { clusterNodes, primaryNodes } from '../cluster-nodes';

const logger = () => ({ warn: jest.fn() });
const member = (id: string) => ({ id, name: id }) as any;
const node = (name: string, role: () => Promise<unknown>) => ({ id: name, name, client: { getRole: jest.fn(role) } as any });

describe('clusterNodes', () => {
  it('skips a missing member with a warning', () => {
    const log = logger();
    const registry = {
      get: jest.fn((id: string) => {
        if (id === 'gone') throw new Error('missing');
        return { id } as any;
      }),
    };
    const seed = { id: 'seed', name: 'seed', client: {} as any };
    const nodes = clusterNodes(registry, seed, [member('m1'), member('gone')], log, 'Cache simulator');
    expect(nodes.map((n) => n.name)).toEqual(['seed', 'm1']);
    expect(nodes.map((n) => n.id)).toEqual(['seed', 'm1']);
    expect(log.warn).toHaveBeenCalledWith('Cache simulator skipped gone: the connection is no longer registered');
  });
});

describe('primaryNodes', () => {
  it('keeps only masters', async () => {
    const nodes = [node('a', async () => ({ role: 'master' })), node('b', async () => ({ role: 'slave' }))];
    const result = await primaryNodes(nodes, logger(), 'Cache simulator');
    expect(result.map((n) => n.name)).toEqual(['a']);
  });

  it('drops a node whose role read rejects', async () => {
    const log = logger();
    const nodes = [node('a', async () => ({ role: 'master' })), node('b', () => Promise.reject(new Error('boom')))];
    const result = await primaryNodes(nodes, log, 'Cache simulator');
    expect(result.map((n) => n.name)).toEqual(['a']);
    expect(log.warn).toHaveBeenCalledWith('Cache simulator could not read the role of b: boom');
  });
});
