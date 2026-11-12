import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' } }),
}));

vi.mock('../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ hasAclLog: true }),
}));

vi.mock('../api/metrics', () => ({
  metricsApi: {
    getAuditStats: () => ({ entriesByUser: { alice: 1, bob: 1 }, entriesByReason: {}, totalEntries: 2, uniqueUsers: 2 }),
    getAuditEntries: () => [],
    getAuditFailedAuth: () => [],
  },
}));

vi.mock('../hooks/usePolling', () => ({
  usePolling: ({ fetcher }: { fetcher: () => unknown }) => ({ data: fetcher(), loading: false }),
}));

import { AuditTrail } from './AuditTrail';

let setParams: (next: Record<string, string>) => void = () => undefined;

function ParamsHandle() {
  const [, set] = useSearchParams();
  setParams = (next) => set(next, { replace: true });
  return null;
}

describe('AuditTrail URL user filter', () => {
  it('does not re-apply a cleared user filter when other params change', () => {
    render(
      <MemoryRouter initialEntries={['/audit?user=alice']}>
        <ParamsHandle />
        <AuditTrail />
      </MemoryRouter>,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('alice');

    fireEvent.change(select, { target: { value: '' } });
    act(() => setParams({ user: 'alice', connection: 'conn-2' }));

    expect(select.value).toBe('');
  });
});
