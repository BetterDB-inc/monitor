import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Projection } from '@betterdb/shared';
import { OutcomePanel } from './OutcomePanel';

const GB = 1024 ** 3;

const projection: Projection = {
  points: [
    { day: 0, keys: 1, bytes: 4 * GB, low: 3 * GB, high: 5 * GB },
    { day: 180, keys: 1, bytes: 6 * GB, low: 2 * GB, high: 10 * GB },
  ],
  daysToMaxmemory: null,
  daysTo80Percent: null,
};

const sizingProjection: Projection = {
  points: [
    { day: 0, keys: 1, bytes: 4 * GB, low: 3 * GB, high: 5 * GB },
    { day: 182, keys: 1, bytes: 8 * GB, low: 2 * GB, high: 14 * GB },
  ],
  daysToMaxmemory: null,
  daysTo80Percent: null,
};

describe('OutcomePanel', () => {
  it('says the node sizing uses the upper bound of the projection', () => {
    render(
      <OutcomePanel
        projection={projection}
        sizingProjection={sizingProjection}
        maxmemory={null}
        policy="noeviction"
        plateauBytes={null}
        horizonLabel="6 months"
      />,
    );
    expect(
      screen.getByText(
        "Smallest nodes that keep the 6-month projection's upper bound (14.00 GB) under 80% of usable memory:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('cache.m7g.2xlarge')).toBeInTheDocument();
  });
});
