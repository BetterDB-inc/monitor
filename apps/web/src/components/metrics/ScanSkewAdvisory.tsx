import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { ScanSkewReport } from '../../types/metrics';

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
          SCAN-family replies on the keys below far exceed the requested COUNT — a signature of a
          skewed hashtable (valkey#3955). Consider re-creating the affected key, or upgrade once
          the upstream fix lands.
        </p>
        <ul className="mt-2 space-y-1">
          {offenders.map((offender) => {
            return (
              <li key={offender.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono break-all">{offender.key}</span>
                <span className="text-muted-foreground">
                  {offender.verb} · {offender.sightings} sightings · worst ~
                  {formatBytes(offender.worstBytesPerElement)} per requested element
                </span>
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
