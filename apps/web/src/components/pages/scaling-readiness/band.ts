import type { ReadinessBand } from '@betterdb/shared';

export const BAND_STYLES: Record<
  ReadinessBand,
  { label: string; badge: string; bar: string; text: string }
> = {
  green: {
    label: 'Ready',
    badge: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    bar: 'bg-green-500',
    text: 'text-green-600 dark:text-green-400',
  },
  yellow: {
    label: 'Watch',
    badge: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    bar: 'bg-yellow-500',
    text: 'text-yellow-600 dark:text-yellow-400',
  },
  red: {
    label: 'Act now',
    badge: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    bar: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
  },
};

export function headroomBand(score: number): ReadinessBand {
  if (score >= 70) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}
