import type { InferenceLatencyProfile } from '@betterdb/shared';
import { formatDurationUs } from '@/lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';

export function SourceAdvisory({ profile }: { profile: InferenceLatencyProfile }) {
  const thresholdFormatted = profile.thresholdUs > 0 ? formatDurationUs(profile.thresholdUs) : '—';
  return (
    <Alert>
      <AlertTitle>
        Percentiles sourced from{' '}
        <code className="px-1 py-0.5 bg-muted rounded text-xs">
          {profile.source === 'commandlog' ? 'command_log_entries' : 'slowlog_entries'}
        </code>
      </AlertTitle>
      <AlertDescription>
        Only entries slower than the active threshold directive{' '}
        <code className="px-1 py-0.5 bg-muted rounded text-xs">{profile.thresholdDirective}</code>{' '}
        (currently <strong>{thresholdFormatted}</strong>) are recorded, so percentiles skew toward
        the tail. A healthy p50 here reflects the slow-call distribution, not your full traffic.
      </AlertDescription>
    </Alert>
  );
}
