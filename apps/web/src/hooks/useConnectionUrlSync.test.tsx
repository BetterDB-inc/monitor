import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useConnectionUrlSync } from './useConnectionUrlSync';

let replaceParams: (next: Record<string, string>) => void = () => undefined;

function Probe({ connectionId }: { connectionId?: string }) {
  useConnectionUrlSync(connectionId);
  const location = useLocation();
  const [, setParams] = useSearchParams();
  replaceParams = (next) => setParams(next, { replace: true });
  return <div data-testid="search">{location.search}</div>;
}

const renderAt = (url: string, connectionId?: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe connectionId={connectionId} />
    </MemoryRouter>,
  );

const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');

describe('useConnectionUrlSync', () => {
  it('names the selected connection in the URL and keeps the page params', () => {
    renderAt('/slowlog?tab=patterns', 'conn-2');
    expect(search().get('connection')).toBe('conn-2');
    expect(search().get('tab')).toBe('patterns');
  });

  it('puts the connection back when a page replaces its own params', () => {
    renderAt('/forecasting', 'conn-2');
    act(() => replaceParams({ tab: 'memory' }));
    expect(search().get('connection')).toBe('conn-2');
    expect(search().get('tab')).toBe('memory');
  });

  it('follows a switch to another connection', () => {
    const view = renderAt('/?connection=conn-1', 'conn-1');
    view.rerender(
      <MemoryRouter initialEntries={['/?connection=conn-1']}>
        <Probe connectionId="conn-3" />
      </MemoryRouter>,
    );
    expect(search().get('connection')).toBe('conn-3');
  });

  it('leaves the URL alone until a connection is selected', () => {
    renderAt('/?connection=conn-9');
    expect(search().get('connection')).toBe('conn-9');
  });
});
