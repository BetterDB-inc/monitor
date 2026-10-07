import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScalingReadiness } from '@betterdb/shared';
import { ReadinessBreakdown } from '../ReadinessBreakdown';
import { ReadinessHeader } from '../ReadinessHeader';

const readiness: ScalingReadiness = {
  connectionId: 'c',
  computedAt: 1,
  score: 25,
  band: 'red',
  bindingDimension: 'memory',
  summary: 'Memory is your binding constraint (93% of 4 GB).',
  cappedBy: 'memory',
  dimensions: [
    { key: 'memory', score: 10, weight: 30, contribution: 3.8, detail: '93% of 4 GB', excludedReason: null },
    { key: 'connections', score: null, weight: 20, contribution: null, detail: null, excludedReason: 'Not reported over OTLP' },
    { key: 'cpu', score: 100, weight: 20, contribution: 25, detail: '5% CPU across 1 thread', excludedReason: null },
    { key: 'opsTrend', score: 100, weight: 15, contribution: 18.8, detail: 'Ops/sec flat or shrinking week over week', excludedReason: null },
    { key: 'keyspaceGrowth', score: 100, weight: 15, contribution: 18.8, detail: 'Keys flat or shrinking week over week', excludedReason: null },
  ],
};

describe('ReadinessHeader', () => {
  it('shows the cap note and partial-dimension note', () => {
    render(<ReadinessHeader readiness={readiness} />);
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Capped by Memory (10)')).toBeInTheDocument();
    expect(screen.getByText('Based on 4 of 5 dimensions')).toBeInTheDocument();
  });

  it('omits the notes when uncapped with all dimensions', () => {
    render(
      <ReadinessHeader
        readiness={{
          ...readiness,
          cappedBy: null,
          dimensions: readiness.dimensions.map((d) => ({ ...d, score: 100, excludedReason: null })),
        }}
      />,
    );
    expect(screen.queryByText(/Capped by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Based on/)).not.toBeInTheDocument();
  });
});

describe('ReadinessBreakdown', () => {
  it('renders a row per dimension with weight and contribution', () => {
    render(<ReadinessBreakdown dimensions={readiness.dimensions} />);
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('93% of 4 GB')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('3.8 pts')).toBeInTheDocument();
  });

  it('greys out excluded dimensions with their reason', () => {
    render(<ReadinessBreakdown dimensions={readiness.dimensions} />);
    const row = screen.getByText('Connections').closest('[data-dimension]')!;
    expect(row).toHaveAttribute('data-excluded', 'true');
    expect(screen.getByText('Not reported over OTLP')).toBeInTheDocument();
  });
});
