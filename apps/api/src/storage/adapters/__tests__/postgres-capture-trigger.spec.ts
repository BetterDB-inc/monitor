import { PostgresAdapter } from '../postgres.adapter';

describe('PostgresAdapter updateCaptureTrigger', () => {
  const adapterWith = (rowCount: number) => {
    const query = jest.fn().mockResolvedValue({ rowCount });
    const adapter = new PostgresAdapter({ connectionString: 'postgres://unused', schema: 'public' });
    adapter['pool'] = { query } as never;
    return { adapter, query };
  };

  it('updates only a row in an expected status', async () => {
    const { adapter, query } = adapterWith(1);

    const updated = await adapter.updateCaptureTrigger('t1', { status: 'fired' }, ['configured', 'queued']);

    expect(updated).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'UPDATE capture_triggers SET status = $1 WHERE id = $2 AND status = ANY($3::text[])',
      ['fired', 't1', ['configured', 'queued']],
    );
  });

  it('reports no update when the row left the expected status', async () => {
    const { adapter } = adapterWith(0);

    await expect(adapter.updateCaptureTrigger('t1', { status: 'fired' }, ['configured'])).resolves.toBe(false);
  });

  it('updates by id alone without expected statuses', async () => {
    const { adapter, query } = adapterWith(1);

    await adapter.updateCaptureTrigger('t1', { status: 'cancelled' });

    expect(query).toHaveBeenCalledWith('UPDATE capture_triggers SET status = $1 WHERE id = $2', [
      'cancelled',
      't1',
    ]);
  });
});
