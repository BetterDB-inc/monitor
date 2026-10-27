import type { Pool } from 'pg';
import { dropSchema } from './postgres-test-utils';

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

const poolOf = (query: jest.Mock) => ({ query }) as unknown as Pool;

describe('dropSchema', () => {
  it('retries a drop that loses a deadlock to a cancelled index build', async () => {
    const query = jest.fn().mockRejectedValueOnce(deadlock()).mockResolvedValue({});

    await dropSchema(poolOf(query), 'scratch', { retryMs: 1 });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith('DROP SCHEMA IF EXISTS scratch CASCADE');
  });

  it('rethrows errors other than a deadlock', async () => {
    const query = jest.fn().mockRejectedValue(new Error('permission denied'));

    await expect(dropSchema(poolOf(query), 'scratch', { retryMs: 1 })).rejects.toThrow(
      'permission denied',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated deadlocks', async () => {
    const query = jest.fn().mockRejectedValue(deadlock());

    await expect(dropSchema(poolOf(query), 'scratch', { retryMs: 1 })).rejects.toThrow(
      'deadlock detected',
    );
    expect(query).toHaveBeenCalledTimes(5);
  });
});
