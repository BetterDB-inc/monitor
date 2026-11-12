import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'conn-1' } }),
}));

vi.mock('../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ hasClientList: true }),
}));

vi.mock('../hooks/usePolling', () => ({
  usePolling: () => ({ data: undefined, loading: false }),
}));

import { ClientAnalytics } from './ClientAnalytics';

let setParams: (next: Record<string, string>) => void = () => undefined;

function ParamsHandle() {
  const [, set] = useSearchParams();
  setParams = (next) => set(next, { replace: true });
  return null;
}

describe('ClientAnalytics URL client filter', () => {
  it('does not reopen a closed client history when other params change', () => {
    render(
      <MemoryRouter initialEntries={['/client-analytics?name=worker']}>
        <ParamsHandle />
        <ClientAnalytics />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Client: worker/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close'));
    act(() => setParams({ name: 'worker', connection: 'conn-2' }));

    expect(screen.queryByText(/Client: worker/)).toBeNull();
  });
});
