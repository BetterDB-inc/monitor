import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import { formatReadinessAxisLabel, formatReadinessTooltipLabel, readinessSpan } from '../ReadinessHistoryChart';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 9, 1, 14, 30).getTime();

describe('ReadinessHistoryChart formatting', () => {
  it('uses times within a single day', () => {
    expect(readinessSpan([{ timestamp: T0 }, { timestamp: T0 + HOUR }])).toBe('time');
    expect(readinessSpan([{ timestamp: T0 }])).toBe('time');
  });

  it('uses date and time for spans across midnight up to 3 days', () => {
    const late = new Date(2026, 9, 1, 23, 30).getTime();
    const early = new Date(2026, 9, 2, 0, 30).getTime();
    expect(readinessSpan([{ timestamp: late }, { timestamp: early }])).toBe('dateTime');
    expect(readinessSpan([{ timestamp: T0 }, { timestamp: T0 + DAY }])).toBe('dateTime');
    expect(readinessSpan([{ timestamp: T0 }, { timestamp: T0 + 3 * DAY }])).toBe('dateTime');
  });

  it('uses dates only for spans over 3 days', () => {
    expect(readinessSpan([{ timestamp: T0 }, { timestamp: T0 + 3 * DAY + 1 }])).toBe('date');
  });

  it('formats axis labels for each span', () => {
    expect(formatReadinessAxisLabel(T0, 'date')).toBe(format(T0, 'MMM d'));
    expect(formatReadinessAxisLabel(T0, 'dateTime')).toBe(format(T0, 'MMM d HH:mm'));
    expect(formatReadinessAxisLabel(T0, 'time')).toBe(
      new Date(T0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('keeps same-day ticks distinct on a 2-day span', () => {
    expect(formatReadinessAxisLabel(T0, 'dateTime')).not.toBe(
      formatReadinessAxisLabel(T0 + 6 * HOUR, 'dateTime'),
    );
  });

  it('includes the date in tooltips unless the span is within one day', () => {
    expect(formatReadinessTooltipLabel(T0, 'date')).toBe(format(T0, 'MMM d, HH:mm'));
    expect(formatReadinessTooltipLabel(T0, 'dateTime')).toBe(format(T0, 'MMM d, HH:mm'));
    expect(formatReadinessTooltipLabel(T0, 'time')).toBe(formatReadinessAxisLabel(T0, 'time'));
  });
});
