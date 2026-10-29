import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from './useConnection';
import { useConnectionUrlSync } from './useConnectionUrlSync';

let replaceParams: (next: Record<string, string>) => void = () => undefined;
let go: (delta: number) => void = () => undefined;
const setConnection = vi.fn();

function connection(id: string): Connection {
  return { id, name: id, host: '127.0.0.1', port: 6379, isConnected: true };
}

const known = ['conn-1', 'conn-2', 'conn-3'].map(connection);

interface ProbeProps {
  connectionId?: string;
  connections?: Connection[];
  loading?: boolean;
}

function Probe({ connectionId, connections = known, loading = false }: ProbeProps) {
  useConnectionUrlSync({ connectionId, connections, loading, setConnection });
  const location = useLocation();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  replaceParams = (next) => setParams(next, { replace: true });
  go = (delta) => navigate(delta);
  return (
    <>
      <div data-testid="search">{location.search}</div>
      <div data-testid="hash">{location.hash}</div>
    </>
  );
}

const renderAt = (entries: string[], props: ProbeProps = {}) =>
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Probe {...props} />
    </MemoryRouter>,
  );

const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');

describe('useConnectionUrlSync', () => {
  beforeEach(() => {
    setConnection.mockReset();
  });

  it('names the selected connection in the URL and keeps the page params', () => {
    renderAt(['/slowlog?tab=patterns'], { connectionId: 'conn-2' });
    expect(search().get('connection')).toBe('conn-2');
    expect(search().get('tab')).toBe('patterns');
  });

  it('puts the connection back when a page replaces its own params', () => {
    renderAt(['/forecasting'], { connectionId: 'conn-2' });
    act(() => replaceParams({ tab: 'memory' }));
    expect(search().get('connection')).toBe('conn-2');
    expect(search().get('tab')).toBe('memory');
  });

  it('follows a switch to another connection', () => {
    const view = renderAt(['/?connection=conn-1'], { connectionId: 'conn-1' });
    view.rerender(
      <MemoryRouter initialEntries={['/?connection=conn-1']}>
        <Probe connectionId="conn-3" />
      </MemoryRouter>,
    );
    expect(search().get('connection')).toBe('conn-3');
    expect(setConnection).not.toHaveBeenCalled();
  });

  it('leaves the URL alone until connections have loaded', () => {
    renderAt(['/?connection=conn-9'], { loading: true });
    expect(search().get('connection')).toBe('conn-9');
  });

  it('switches to the connection named by a history entry', () => {
    renderAt(['/slowlog?connection=conn-1', '/latency?connection=conn-2'], { connectionId: 'conn-2' });
    act(() => go(-1));
    expect(setConnection).toHaveBeenCalledWith('conn-1');
    expect(search().get('connection')).toBe('conn-1');
  });

  it('rewrites a history entry that names a connection that no longer exists', () => {
    renderAt(['/slowlog?connection=gone', '/latency?connection=conn-2'], { connectionId: 'conn-2' });
    act(() => go(-1));
    expect(setConnection).not.toHaveBeenCalled();
    expect(search().get('connection')).toBe('conn-2');
  });

  it('drops the connection from the URL once none is selected', () => {
    renderAt(['/?connection=conn-1&tab=x'], { connections: [] });
    expect(search().has('connection')).toBe(false);
    expect(search().get('tab')).toBe('x');
  });

  it('keeps the hash when it names the connection', () => {
    renderAt(['/slowlog#top'], { connectionId: 'conn-2' });
    expect(search().get('connection')).toBe('conn-2');
    expect(screen.getByTestId('hash').textContent).toBe('#top');
  });
});
