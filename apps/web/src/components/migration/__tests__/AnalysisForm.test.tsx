import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Connection } from '../../../hooks/useConnection';
import { AnalysisForm } from '../AnalysisForm';
import { MigrationPlanProvider } from '../MigrationPlanProvider';
import { fetchApi } from '../../../api/client';

const state: { connections: Connection[]; currentConnection: Connection | null } = {
  connections: [],
  currentConnection: null,
};

vi.mock('../../../hooks/useConnection', () => ({
  useConnection: () => ({
    connections: state.connections,
    currentConnection: state.currentConnection,
    loading: false,
    error: null,
    setConnection: vi.fn(),
    refreshConnections: vi.fn(),
    hasNoConnections: state.connections.length === 0,
  }),
}));

vi.mock('../../../api/client', () => ({
  fetchApi: vi.fn(),
}));

function conn(partial: Partial<Connection> & Pick<Connection, 'id' | 'name'>): Connection {
  return {
    host: '10.0.0.1',
    port: 6379,
    isConnected: true,
    connectionType: 'direct',
    capabilities: { dbType: 'redis', version: '7.2' },
    ...partial,
  };
}

const SOURCE = conn({ id: 'src', name: 'prod-cache-eu' });
const TARGET = conn({
  id: 'tgt',
  name: 'valkey-prod-01',
  host: '10.0.7.9',
  capabilities: { dbType: 'valkey', version: '8.1' },
});

function setConnections(connections: Connection[], current: Connection | null = null) {
  state.connections = connections;
  state.currentConnection = current;
}

function renderForm(onStart: (analysisId: string) => void = vi.fn()) {
  return render(
    <MigrationPlanProvider>
      <AnalysisForm onStart={onStart} isCloudMode={false} />
    </MigrationPlanProvider>,
  );
}

async function pickTarget(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /select target/i }));
  const row = await screen.findByRole('button', { name: new RegExp(name, 'i') });
  fireEvent.click(row);
}

describe('AnalysisForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConnections([]);
  });

  it('blocks with an explanation when fewer than two connections exist', () => {
    setConnections([SOURCE], SOURCE);
    renderForm();

    expect(screen.getByText(/a migration needs two instances/i)).toBeInTheDocument();
    expect(screen.getByText(/connection menu at the top of the page/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start analysis/i })).not.toBeInTheDocument();
  });

  it('names the single connection you do have so the screen does not look broken', () => {
    setConnections([SOURCE], SOURCE);
    renderForm();

    expect(screen.getByText('prod-cache-eu')).toBeInTheDocument();
  });

  it('cannot start until both endpoints are chosen', () => {
    setConnections([SOURCE, TARGET]);
    renderForm();

    expect(screen.getByRole('button', { name: /start analysis/i })).toBeDisabled();
  });

  it('offers both slots when nothing is pre-selected', () => {
    setConnections([SOURCE, TARGET]);
    renderForm();

    expect(screen.getByRole('button', { name: /select source/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /select target/i })).toBeInTheDocument();
    expect(screen.queryByText(/current connection/i)).not.toBeInTheDocument();
  });

  it('marks a source that was pre-filled from the current connection', () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    expect(screen.getByText(/current connection/i)).toBeInTheDocument();
    expect(screen.getByText('prod-cache-eu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /select target/i })).toBeInTheDocument();
  });

  it('states the direction once both endpoints are set', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    await pickTarget('valkey-prod-01');

    expect(await screen.findByText('Redis 7.2 → Valkey 8.1')).toBeInTheDocument();
    expect(screen.getByText('engine change')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start analysis/i })).toBeEnabled();
  });

  it('confirms that analysis does not modify either instance', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    await pickTarget('valkey-prod-01');

    expect(await screen.findByText(/neither instance is modified/i)).toBeInTheDocument();
  });

  it('will not let the source be chosen again as the target', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /select target/i }));

    const sourceRow = await screen.findByRole('button', { name: /prod-cache-eu/i });
    expect(sourceRow).toBeDisabled();
    expect(screen.getByText(/already the source/i)).toBeInTheDocument();
  });

  it('disables an offline instance as a migration target', async () => {
    const offline = conn({ id: 'off', name: 'analytics-cache', isConnected: false });
    setConnections([SOURCE, TARGET, offline], SOURCE);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /select target/i }));

    const offlineRow = await screen.findByRole('button', { name: /analytics-cache/i });
    expect(offlineRow).toBeDisabled();
    expect(screen.getByText(/offline — cannot accept writes/i)).toBeInTheDocument();
  });

  it('lists selectable instances above the ones that cannot be chosen', async () => {
    const offline = conn({ id: 'off', name: 'analytics-cache', isConnected: false });
    const spare = conn({ id: 'spare', name: 'staging-cache' });
    setConnections([SOURCE, offline, TARGET, spare], SOURCE);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /select target/i }));

    const rows = await screen.findAllByRole('button', { name: /:6379/i });
    const names = rows.map((row) => {
      return row.textContent ?? '';
    });

    expect(names).toHaveLength(4);
    expect(names[0]).toMatch(/valkey-prod-01|staging-cache/);
    expect(names[1]).toMatch(/valkey-prod-01|staging-cache/);
    expect(names[2]).toMatch(/prod-cache-eu|analytics-cache/);
    expect(names[3]).toMatch(/prod-cache-eu|analytics-cache/);
  });

  it('clears the target back to an empty slot', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    await pickTarget('valkey-prod-01');
    expect(await screen.findByText('valkey-prod-01')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear target/i }));

    expect(screen.queryByText('valkey-prod-01')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /select target/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start analysis/i })).toBeDisabled();
  });

  it('clears the source even when it was pre-filled', () => {
    setConnections([SOURCE, TARGET], SOURCE);
    renderForm();

    expect(screen.getByText('prod-cache-eu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear source/i }));

    expect(screen.queryByText('prod-cache-eu')).not.toBeInTheDocument();
    expect(screen.queryByText(/current connection/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /select source/i })).toBeInTheDocument();
  });

  it('blocks a plan that involves an agent-backed instance', async () => {
    const agent = conn({ id: 'agent', name: 'edge-agent-us', connectionType: 'agent' });
    setConnections([SOURCE, agent], agent);
    renderForm();

    await pickTarget('prod-cache-eu');

    expect(await screen.findByRole('alert')).toHaveTextContent(/agent/i);
    expect(screen.getByRole('button', { name: /start analysis/i })).toBeDisabled();
  });

  it('starts the analysis with the chosen endpoints and sample size', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    const onStart = vi.fn();
    vi.mocked(fetchApi).mockResolvedValue({ id: 'analysis-1' });

    renderForm(onStart);
    await pickTarget('valkey-prod-01');
    fireEvent.click(screen.getByRole('button', { name: /start analysis/i }));

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/migration/analysis', {
        method: 'POST',
        body: JSON.stringify({
          sourceConnectionId: 'src',
          targetConnectionId: 'tgt',
          scanSampleSize: 10000,
        }),
      });
    });
    expect(onStart).toHaveBeenCalledWith('analysis-1');
  });

  it('rewrites an offline-connection failure into something actionable', async () => {
    setConnections([SOURCE, TARGET], SOURCE);
    vi.mocked(fetchApi).mockRejectedValue(new Error('Stream isnt writeable'));

    renderForm();
    await pickTarget('valkey-prod-01');
    fireEvent.click(screen.getByRole('button', { name: /start analysis/i }));

    expect(
      await screen.findByText(/valkey-prod-01 — the instance appears to be offline/i),
    ).toBeInTheDocument();
  });
});
