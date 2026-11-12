import { ClientListCache } from '../client-list-cache';
import { ClientInfo } from '../../types/metrics.types';

const client = {
  id: '7',
  addr: '10.0.0.1:1',
  name: 'api',
  user: 'default',
  flags: 'N',
  age: 10,
  cmd: 'get',
  'tot-cmds': '42',
  'lib-name': 'valkey-glide',
} as unknown as ClientInfo;

describe('ClientListCache', () => {
  it('keeps only the fields attribution reads', () => {
    const cache = new ClientListCache();

    cache.record('conn-1', [client], 1_000);

    expect(cache.latest('conn-1')).toEqual({
      takenAt: 1_000,
      clients: [
        {
          id: '7',
          addr: '10.0.0.1:1',
          name: 'api',
          user: 'default',
          flags: 'N',
          age: 10,
          'tot-cmds': '42',
        },
      ],
    });
  });

  it('forgets a connection', () => {
    const cache = new ClientListCache();
    cache.record('conn-1', [client], 1_000);

    cache.forget('conn-1');

    expect(cache.latest('conn-1')).toBeUndefined();
  });
});
