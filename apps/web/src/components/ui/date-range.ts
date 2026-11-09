import type { DateRange } from './date-range-picker';

export function dateRangeFromParams(
  start: string | null,
  end: string | null,
): DateRange | undefined {
  if (!start || !end) return undefined;
  const from = new Date(Number(start));
  const to = new Date(Number(end));
  return isNaN(from.getTime()) || isNaN(to.getTime()) ? undefined : { from, to };
}
