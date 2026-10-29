import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import type { MigrationAnalysisResult } from '@betterdb/shared';

const { state } = vi.hoisted(() => ({
  state: { job: null as unknown },
}));

vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => true }),
}));
vi.mock('../../api/client', () => ({
  fetchApi: vi.fn(),
}));
vi.mock('../../components/migration/AnalysisForm', () => ({
  AnalysisForm: ({ onStart }: { onStart: (id: string) => void }) => (
    <button type="button" onClick={() => onStart('a1')}>
      fake start
    </button>
  ),
}));
vi.mock('../../components/migration/AnalysisProgressBar', () => ({
  AnalysisProgressBar: ({ onComplete }: { onComplete: (job: unknown) => void }) => {
    useEffect(() => {
      onComplete(state.job);
    }, [onComplete]);
    return null;
  },
}));
vi.mock('../../components/migration/MigrationReport', () => ({
  MigrationReport: () => <div>report</div>,
}));
vi.mock('../../components/migration/ExportBar', () => ({
  ExportBar: () => null,
}));
vi.mock('../../components/migration/analysis-form/HowItWorks', () => ({
  HowItWorks: () => null,
}));

import { MigrationPage } from '../MigrationPage';

const COMPLETED: MigrationAnalysisResult = {
  id: 'a1',
  status: 'completed',
  progress: 100,
  createdAt: 0,
  sourceConnectionId: 'src',
  sourceConnectionName: 'prod-cache-eu',
  incompatibilities: [],
  blockingCount: 0,
  warningCount: 0,
};

async function runAnalysis(job: MigrationAnalysisResult) {
  state.job = job;
  render(<MigrationPage isCloudMode={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'fake start' }));
  await screen.findByText('report');
}

describe('MigrationPage after analysis', () => {
  beforeEach(() => {
    state.job = null;
  });

  it('offers migration controls for an analysis with a target connection', async () => {
    await runAnalysis({ ...COMPLETED, targetConnectionId: 'tgt', targetConnectionName: 'valkey-prod-01' });

    expect(screen.getByRole('button', { name: /start migration/i })).toBeInTheDocument();
    expect(screen.getByText(/migration mode/i)).toBeInTheDocument();
  });

  it('hides migration controls after a standalone ElastiCache Serverless check', async () => {
    await runAnalysis({ ...COMPLETED, targetProfile: 'elasticache_serverless' });

    expect(screen.queryByRole('button', { name: /start migration/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/migration mode/i)).not.toBeInTheDocument();
    expect(screen.getByText(/readiness check against elasticache serverless/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run another analysis/i })).toBeInTheDocument();
  });
});
