import type { CaptureSessionStatus } from '@betterdb/shared';

const STYLES: Record<CaptureSessionStatus, string> = {
  running: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  completed: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  truncated: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
  skipped: 'bg-muted text-muted-foreground',
};

export function SessionStatusBadge({ status }: { status: CaptureSessionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {status}
    </span>
  );
}
