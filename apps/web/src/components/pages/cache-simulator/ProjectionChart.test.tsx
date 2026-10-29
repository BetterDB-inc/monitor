import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Projection } from '@betterdb/shared';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 600, height: 320 }),
  };
});

import { ProjectionChart } from './ProjectionChart';

const GB = 1024 ** 3;

const projection = (bytes: number[]): Projection => ({
  points: bytes.map((value, day) => ({ day, keys: 1, bytes: value, low: value, high: value })),
  daysToMaxmemory: null,
  daysTo80Percent: null,
});

function referenceLine(container: HTMLElement, stroke: string, label: string) {
  const line = container.querySelector(`.recharts-reference-line-line[stroke="${stroke}"]`);
  const text = [...container.querySelectorAll('.recharts-label')].find((node) => node.textContent === label);
  return { lineY: Number(line?.getAttribute('y1')), textY: Number(text?.getAttribute('y')) };
}

const tickLabels = (container: HTMLElement, axis: 'xAxis' | 'yAxis') =>
  [...container.querySelectorAll(`.recharts-${axis}-tick-labels .recharts-cartesian-axis-tick-value`)].map((node) => node.textContent);

describe('ProjectionChart', () => {
  it.each([
    ['ends on a tick', 2 * GB],
    ['sits between ticks', 1.9 * GB],
  ])('draws the maxmemory label above its line and the headroom label below its own when maxmemory %s', (_, maxmemory) => {
    const { container } = render(<ProjectionChart projection={projection([GB, 1.2 * GB, 1.4 * GB])} maxmemory={maxmemory} />);
    const max = referenceLine(container, 'var(--destructive)', 'maxmemory');
    const headroom = referenceLine(container, 'var(--muted-foreground)', '80%');
    expect(max.textY).toBeLessThan(max.lineY);
    expect(headroom.textY).toBeGreaterThan(headroom.lineY);
    expect(max.textY).toBeGreaterThanOrEqual(14);
  });

  it('labels the last day of the horizon', () => {
    const { container } = render(<ProjectionChart projection={projection(Array.from({ length: 31 }, () => GB))} maxmemory={null} />);
    const ticks = tickLabels(container, 'xAxis');
    expect(ticks[ticks.length - 1]).toBe('30d');
  });

  it('labels every Y tick in one unit', () => {
    const { container } = render(<ProjectionChart projection={projection([0.5 * GB, 0.6 * GB])} maxmemory={GB} />);
    const ticks = tickLabels(container, 'yAxis');
    expect(ticks).toEqual(['0 GB', '0.2 GB', '0.4 GB', '0.6 GB', '0.8 GB', '1.0 GB', '1.2 GB']);
  });
});
