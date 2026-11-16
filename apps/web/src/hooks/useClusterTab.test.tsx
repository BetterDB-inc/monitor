import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useClusterTab } from './useClusterTab';

function renderTab(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => {
      const [tab, setTab] = useClusterTab();
      return { tab, setTab, search: useLocation().search };
    },
    { wrapper },
  );
}

describe('useClusterTab', () => {
  it('opens the overview when the URL names no tab', () => {
    expect(renderTab('/cluster').result.current.tab).toBe('overview');
  });

  it('opens the tab named in the URL', () => {
    expect(renderTab('/cluster?tab=disagreements').result.current.tab).toBe('disagreements');
    expect(renderTab('/cluster?connection=c1&tab=nodes').result.current.tab).toBe('nodes');
  });

  it('falls back to the overview for a tab it does not know', () => {
    expect(renderTab('/cluster?tab=nope').result.current.tab).toBe('overview');
  });

  it('writes the chosen tab to the URL and keeps the connection', () => {
    const { result } = renderTab('/cluster?connection=c1');

    act(() => result.current.setTab('disagreements'));

    expect(result.current.tab).toBe('disagreements');
    expect(result.current.search).toBe('?connection=c1&tab=disagreements');
  });

  it('drops the tab and the picked node from the URL on the way back to the overview', () => {
    const { result } = renderTab('/cluster?connection=c1&tab=nodes&node=abc');

    act(() => result.current.setTab('overview'));

    expect(result.current.tab).toBe('overview');
    expect(result.current.search).toBe('?connection=c1');
  });
});
