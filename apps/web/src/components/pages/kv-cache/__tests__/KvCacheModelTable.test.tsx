import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { KvCacheFootprintSnapshot } from '@betterdb/shared';
import { KvCacheModelTable } from '../KvCacheModelTable';

const latest = {
  layout: 'vllm',
  perModel: [{ model: 'llama', dtype: 'bfloat16', chunksEst: 10, bytesEst: 2048 }],
} as unknown as KvCacheFootprintSnapshot;

describe('KvCacheModelTable', () => {
  it('says which columns come from the latest scan and which from the selected range', () => {
    render(<KvCacheModelTable latest={latest} buckets={[]} />);
    expect(
      screen.getByRole('columnheader', { name: 'Hit rate (selected range)' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Chunks and bytes are from the latest scan/)).toBeInTheDocument();
  });

  it('shows each model its own layout rather than the connection layout', () => {
    const mixed = {
      layout: 'mixed',
      perModel: [
        { model: 'llama', dtype: 'bfloat16', chunksEst: 10, bytesEst: 2048, layout: 'two_key' },
        { model: 'qwen', dtype: 'half', chunksEst: 5, bytesEst: 1024, layout: 'single_key' },
      ],
    } as unknown as KvCacheFootprintSnapshot;
    render(<KvCacheModelTable latest={mixed} buckets={[]} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('two_key');
    expect(rows[1]).toHaveTextContent('single_key');
    expect(screen.queryByText('mixed')).not.toBeInTheDocument();
  });
});
