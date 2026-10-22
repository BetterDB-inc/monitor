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
});
