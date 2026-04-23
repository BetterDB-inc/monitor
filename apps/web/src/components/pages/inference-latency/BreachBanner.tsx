import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { formatDurationUs } from '@/lib/utils.ts';

export interface Breach {
  indexName: string;
  currentP99Us: number;
  thresholdUs: number;
}

export function BreachBanner({ breaches }: { breaches: Breach[] }) {
  if (breaches.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Active SLA breach{breaches.length === 1 ? '' : 'es'}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4 space-y-1">
          {breaches.map((b) => (
            <li key={b.indexName} className="font-mono text-sm">
              {b.indexName}: p99 {formatDurationUs(b.currentP99Us)} &gt; threshold{' '}
              {formatDurationUs(b.thresholdUs)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
