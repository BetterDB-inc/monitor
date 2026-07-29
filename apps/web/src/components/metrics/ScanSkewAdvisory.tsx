import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { ScanSkewReport } from '../../types/metrics';

function formatSightings(count: number): string {
  if (count === 1) {
    return '1 sighting';
  }
  return `${count} sightings`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

/**
 * Advisory for SCAN-family replies whose byte size vastly exceeds the
 * requested COUNT — the signature of a degenerate hash chain (valkey#3955).
 * Analysis rides the persisted large-reply commandlog; clears on its own when
 * offending keys stop recurring in the analyzed window.
 */
export function ScanSkewAdvisory({ report }: { report: ScanSkewReport | null | undefined }) {
  const offenders = report?.offenders ?? [];

  if (offenders.length === 0) {
    return null;
  }

  return (
    <Alert className="border-yellow-500">
      <AlertTriangle className="w-4 h-4 text-yellow-500" />
      <AlertTitle>Possible degenerate hash chains</AlertTitle>
      <AlertDescription>
        <p>
          SCAN-family replies on the entries below far exceed the requested COUNT — a signature of
          a skewed hashtable (valkey#3955).
        </p>
        <ul className="mt-2 space-y-2">
          {offenders.map((offender) => {
            return (
              <li key={offender.key} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono break-all">{offender.key}</span>
                  <span className="text-muted-foreground">
                    {offender.verb} · {formatSightings(offender.sightings)} · worst ~
                    {formatBytes(offender.worstBytesPerElement)} per requested element
                  </span>
                </div>
                {offender.message !== undefined && offender.message !== '' && (
                  <p className="text-muted-foreground mt-0.5">{offender.message}</p>
                )}
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
