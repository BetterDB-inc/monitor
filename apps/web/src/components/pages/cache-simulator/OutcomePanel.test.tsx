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

const flatSizing: Projection = {
  points: [
    { day: 0, keys: 1, bytes: 4 * GB, low: 4 * GB, high: 4 * GB },
    { day: 182, keys: 1, bytes: 6 * GB, low: 6 * GB, high: 6 * GB },
  ],
  daysToMaxmemory: null,
  daysTo80Percent: null,
};

function renderPanel(sizing: Projection, maxmemory: number | null) {
  render(
    <OutcomePanel
      projection={projection}
      sizingProjection={sizing}
      maxmemory={maxmemory}
      policy="noeviction"
      plateauBytes={null}
      horizonLabel="6 months"
    />,
  );
}

describe('OutcomePanel', () => {
  it('sizes nodes on the highest point of the range', () => {
    renderPanel(sizingProjection, null);
    expect(
      screen.getByText(
        "Smallest nodes that keep the 6-month projection's highest point, at the upper end of its range (14.00 GB), under 80% of usable memory:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('cache.m7g.2xlarge')).toBeInTheDocument();
  });

  it('sizes nodes on the highest point when there is no range', () => {
    renderPanel(flatSizing, null);
    expect(
      screen.getByText("Smallest nodes that keep the 6-month projection's highest point (6.00 GB) under 80% of usable memory:"),
    ).toBeInTheDocument();
  });

  it('warns when only the upper end of the range reaches maxmemory', () => {
    renderPanel(sizingProjection, 12 * GB);
    expect(
      screen.getByText(
        'Stays under maxmemory for at least 6 months at the projected rate, but the upper end of the range reaches it in ~182 days.',
      ),
    ).toBeInTheDocument();
  });

  it('says the upper end of the range is already at maxmemory when it starts there', () => {
    renderPanel(sizingProjection, 5 * GB);
    expect(
      screen.getByText(
        'Stays under maxmemory for at least 6 months at the projected rate, but the upper end of the range is already at it.',
      ),
    ).toBeInTheDocument();
  });

  it('says it stays under maxmemory when the whole range does', () => {
    renderPanel(sizingProjection, 20 * GB);
    expect(screen.getByText('Stays under maxmemory for at least 6 months.')).toBeInTheDocument();
  });
});
