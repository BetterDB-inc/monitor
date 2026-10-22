import { parseKeyspaceDatabases } from './keyspace-databases';

describe('parseKeyspaceDatabases', () => {
  it('lists non-empty databases sorted by index', () => {
    expect(
      parseKeyspaceDatabases({
        db3: { keys: 2, expires: 0, avg_ttl: 0 },
        db0: { keys: 5, expires: 0, avg_ttl: 0 },
        db4: { keys: 0, expires: 0, avg_ttl: 0 },
        junk: 'x',
        db7: 'malformed',
      }),
    ).toEqual([
      { db: 0, keys: 5 },
      { db: 3, keys: 2 },
    ]);
  });

  it('returns an empty list without a keyspace section', () => {
    expect(parseKeyspaceDatabases(undefined)).toEqual([]);
  });
});
