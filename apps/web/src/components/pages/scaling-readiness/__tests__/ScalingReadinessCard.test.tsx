import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScalingReadiness } from '@betterdb/shared';
import { ScalingReadinessCardView } from '../ScalingReadinessCard';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const result = (o: Partial<ScalingReadiness> = {}): ScalingReadiness => ({
  connectionId: 'c',
  computedAt: 1,
  score: 62,
  band: 'yellow',
  bindingDimension: 'memory',
  summary: 'Memory is your binding constraint (82% of 4 GB).',
  cappedBy: null,
  dimensions: [],
  ...o,
});

describe('ScalingReadinessCardView', () => {
  it('shows score, band, summary and a details link', () => {
    render(<ScalingReadinessCardView readiness={result()} isLoading={false} />);
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
    expect(screen.getByText('Memory is your binding constraint (82% of 4 GB).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View details/ })).toHaveAttribute('href', '/scaling-readiness');
  });

  it('shows the not-enough-data state for a null score', () => {
    render(
      <ScalingReadinessCardView
        readiness={result({ score: null, band: null, summary: 'Not enough data yet' })}
        isLoading={false}
      />,
    );
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByText('62')).not.toBeInTheDocument();
  });

  it('shows a loading state', () => {
    render(<ScalingReadinessCardView readiness={undefined} isLoading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
