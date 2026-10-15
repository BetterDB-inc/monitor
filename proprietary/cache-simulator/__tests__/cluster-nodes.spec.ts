import { clusterNodes, primaryNodes } from '../cluster-nodes';

const logger = () => ({ warn: jest.fn() });
const member = (id: string) => ({ id, name: id }) as any;
const self = (flags: string[], slots: number[][] = [[0, 100]]) => async () => [
  { flags: ['master'], slots: [[101, 200]] },
  { flags: ['myself', ...flags], slots },
];
const node = (name: string, view: () => Promise<unknown>) => ({ id: name, name, client: { getClusterNodes: jest.fn(view) } as any });

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
  it('keeps only masters that serve slots', async () => {
    const nodes = [node('a', self(['master'])), node('b', self(['slave'], [])), node('c', self(['master'], []))];
    const result = await primaryNodes(nodes, logger(), 'Cache simulator');
    expect(result.map((n) => n.name)).toEqual(['a']);
  });

  it('drops a node that does not report itself', async () => {
    const nodes = [node('a', self(['master'])), node('b', async () => [{ flags: ['master'], slots: [[0, 100]] }])];
    const result = await primaryNodes(nodes, logger(), 'Cache simulator');
    expect(result.map((n) => n.name)).toEqual(['a']);
  });

  it('drops a node whose cluster view read rejects', async () => {
    const log = logger();
    const nodes = [node('a', self(['master'])), node('b', () => Promise.reject(new Error('boom')))];
    const result = await primaryNodes(nodes, log, 'Cache simulator');
    expect(result.map((n) => n.name)).toEqual(['a']);
    expect(log.warn).toHaveBeenCalledWith('Cache simulator could not read the cluster role of b: boom');
  });
});
