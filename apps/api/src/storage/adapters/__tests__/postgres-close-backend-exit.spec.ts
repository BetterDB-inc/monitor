import { PostgresAdapter } from '../postgres.adapter';

describe('PostgresAdapter backend-exit wait', () => {
  it('keeps waiting after a failed status query until the backend is gone', async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 0 });
    const adapter = new PostgresAdapter({ connectionString: 'postgres://unused', schema: 'public' });
    adapter['pool'] = { query } as never;

    await adapter['waitForBackendExit'](4242);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [4242]);
  });
});
