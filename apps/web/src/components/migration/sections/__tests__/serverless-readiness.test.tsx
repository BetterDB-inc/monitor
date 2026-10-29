import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MigrationAnalysisResult } from '@betterdb/shared';
import { VerdictSection } from '../VerdictSection';
import { SummarySection } from '../SummarySection';

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

describe('SummarySection target profile', () => {
  it('names ElastiCache Serverless as the target of a standalone check', () => {
    render(<SummarySection job={{ ...BASE, targetProfile: 'elasticache_serverless' }} />);

    expect(screen.getByText('ElastiCache Serverless')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });
});
