import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import { formatReadinessAxisLabel, formatReadinessTooltipLabel, isMultiDaySpan } from '../ReadinessHistoryChart';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 9, 1, 14, 30).getTime();

describe('ReadinessHistoryChart formatting', () => {
  it('treats spans over 24h as multi-day', () => {
    expect(isMultiDaySpan([{ timestamp: T0 }, { timestamp: T0 + DAY }])).toBe(false);
    expect(isMultiDaySpan([{ timestamp: T0 }, { timestamp: T0 + DAY + 1 }])).toBe(true);
    expect(isMultiDaySpan([{ timestamp: T0 }])).toBe(false);
  });

  it('formats axis labels as dates for multi-day spans and times otherwise', () => {
    expect(formatReadinessAxisLabel(T0, true)).toBe(format(T0, 'MMM d'));
    expect(formatReadinessAxisLabel(T0, false)).toBe(
      new Date(T0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('includes the date and time in multi-day tooltip labels', () => {
    expect(formatReadinessTooltipLabel(T0, true)).toBe(format(T0, 'MMM d, HH:mm'));
    expect(formatReadinessTooltipLabel(T0, false)).toBe(formatReadinessAxisLabel(T0, false));
  });
});
