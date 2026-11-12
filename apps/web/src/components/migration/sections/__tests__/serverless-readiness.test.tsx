import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MigrationAnalysisResult } from '@betterdb/shared';
import { VerdictSection } from '../VerdictSection';
import { SummarySection } from '../SummarySection';
import { MigrationPath } from '../../analysis-form/MigrationPath';

afterEach(() => {
  cleanup();
});

const BASE: MigrationAnalysisResult = {
  id: 'a1',
  status: 'completed',
  progress: 100,
  createdAt: 0,
  sourceConnectionName: 'prod-cache-eu',
  sourceDbType: 'redis',
  sourceDbVersion: '7.2.4',
};

describe('VerdictSection AWS-only issues', () => {
  it('badges an issue that only blocks the AWS migration tool', () => {
    render(
      <VerdictSection
        job={{
          ...BASE,
          incompatibilities: [
            {
              severity: 'warning',
              category: 'serverless_readiness',
              title: 'Standalone source',
              detail: 'The AWS migration tool accepts cluster-mode sources only.',
              awsToolOnly: true,
            },
          ],
          blockingCount: 0,
          warningCount: 1,
        }}
      />,
    );

    expect(screen.getByText('Blocks AWS migration')).toBeInTheDocument();
  });

  it('does not badge ordinary issues', () => {
    render(
      <VerdictSection
        job={{
          ...BASE,
          incompatibilities: [
            {
              severity: 'warning',
              category: 'serverless_readiness',
              title: 'Scripts in the script cache',
              detail: 'Reload scripts.',
            },
          ],
          blockingCount: 0,
          warningCount: 1,
        }}
      />,
    );

    expect(screen.queryByText('Blocks AWS migration')).not.toBeInTheDocument();
  });
});

describe('VerdictSection clean result', () => {
  it('reports a clean readiness check without calling the migration safe', () => {
    render(
      <VerdictSection
        job={{ ...BASE, targetProfile: 'elasticache_serverless', incompatibilities: [], blockingCount: 0, warningCount: 0 }}
      />,
    );

    expect(screen.getByText('No ElastiCache Serverless readiness issues found.')).toBeInTheDocument();
    expect(screen.queryByText(/Migration appears safe/)).not.toBeInTheDocument();
  });

  it('keeps the safe banner for a migration with a target', () => {
    render(
      <VerdictSection
        job={{ ...BASE, targetConnectionId: 'conn-2', incompatibilities: [], blockingCount: 0, warningCount: 0 }}
      />,
    );

    expect(screen.getByText('No compatibility issues found. Migration appears safe.')).toBeInTheDocument();
  });
});

describe('MigrationPath empty copy', () => {
  it('asks for a source only in Serverless mode', () => {
    render(<MigrationPath direction={null} endpointsChosen={false} serverlessCheck />);

    expect(screen.getByText('pick a source')).toBeInTheDocument();
    expect(screen.queryByText('pick both endpoints')).not.toBeInTheDocument();
  });

  it('asks for both endpoints otherwise', () => {
    render(<MigrationPath direction={null} endpointsChosen={false} />);

    expect(screen.getByText('pick both endpoints')).toBeInTheDocument();
  });
});

describe('SummarySection target profile', () => {
  it('shows the connected target and the Serverless badge for a Serverless target connection', () => {
    render(
      <SummarySection
        job={{
          ...BASE,
          targetConnectionId: 'conn-2',
          targetConnectionName: 'aws-serverless',
          targetDbType: 'valkey',
          targetDbVersion: '8.1.0',
          targetProfile: 'elasticache_serverless',
        }}
      />,
    );

    expect(screen.getByText('aws-serverless')).toBeInTheDocument();
    expect(screen.getByText('ElastiCache Serverless')).toBeInTheDocument();
  });

  it('names ElastiCache Serverless as the target of a standalone check', () => {
    render(<SummarySection job={{ ...BASE, targetProfile: 'elasticache_serverless' }} />);

    expect(screen.getByText('ElastiCache Serverless')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });
});
