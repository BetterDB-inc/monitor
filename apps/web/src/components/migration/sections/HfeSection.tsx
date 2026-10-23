import type { MigrationAnalysisResult } from '@betterdb/shared';
import { AlertTriangle, CheckCircle } from 'lucide-react';

interface Props {
  job: MigrationAnalysisResult;
}

export function HfeSection({ job }: Props) {
  if (job.hfeSupported === undefined && job.hfeDetected === undefined) {
    return (
      <section className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-2">Hash Field Expiry</h2>
        <p className="text-sm text-muted-foreground">Not available for this analysis.</p>
      </section>
    );
  }

  return (
    <section className="bg-card border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-3">Hash Field Expiry</h2>

      {job.hfeSupported === false ? (
        <p className="text-sm text-muted-foreground">
          HFE check not available — the source does not support Hash Field Expiry (needs Valkey 9.0+ or Redis 7.4+), so no hash on it can carry per-field TTLs.
        </p>
      ) : job.hfeDetected ? (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4">
          <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">
              Hash Field Expiry keys detected (~{(job.hfeKeyCount ?? 0).toLocaleString()} estimated).
            </p>
            <p className="text-sm mt-1">
              Command mode copies per-field TTLs when the target supports HFE (Valkey 9.0+ or
              Redis 7.4+). A target without HFE is a blocking incompatibility: execution is
              rejected unless it is explicitly forced with a reason, and even then command mode
              fails the hashes whose field TTLs it cannot store instead of copying them without
              those TTLs.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-green-700">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm">Not detected in sample.</span>
        </div>
      )}

      {(job.hfeOversizedHashesSkipped ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground mt-2">
          Note: {job.hfeOversizedHashesSkipped} hash key(s) with &gt;10,000 fields were skipped during HFE sampling.
        </p>
      )}
    </section>
  );
}
