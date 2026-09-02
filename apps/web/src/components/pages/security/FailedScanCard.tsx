import { Link } from 'react-router-dom';
import type { CveSourceStatus } from '@betterdb/shared';
import { Button } from '../../ui/button';
import { ScanFailureReason } from './ScanFailureReason';
import { SourceDots } from './SourceDots';
import type { FailedNode } from './scan-error';

interface FailedScanCardProps {
  headline: string;
  detail: string;
  summary: string;
  guidance: string;
  nodes: FailedNode[];
  sources: CveSourceStatus[];
  connectionAtFault: boolean;
  retrying: boolean;
  onRetry: () => void;
}

function sourceCaption(sources: CveSourceStatus[]): string | null {
  if (sources.length === 0) {
    return null;
  }

  const answered = sources.filter((source) => {
    return source.state === 'ok';
  });

  if (answered.length < sources.length) {
    return null;
  }

  return `All ${sources.length} advisory feeds answered. The failure is on this connection, not on the data.`;
}

export function FailedScanCard({
  headline,
  detail,
  summary,
  guidance,
  nodes,
  sources,
  connectionAtFault,
  retrying,
  onRetry,
}: FailedScanCardProps) {
  const caption = connectionAtFault ? sourceCaption(sources) : null;

  return (
    <section
      data-testid="failed-scan"
      className="flex flex-1 flex-col items-center justify-center gap-5 text-center"
    >
      <span className="border-destructive/45 bg-destructive/13 flex size-[72px] items-center justify-center rounded-full border">
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--destructive)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="6" rx="1.5" />
          <rect x="3" y="14" width="18" height="6" rx="1.5" />
          <path d="M7 7h.01" />
          <path d="M7 17h.01" />
          <path d="M3 21 21 3" />
        </svg>
      </span>

      <div className="flex flex-col items-center gap-2">
        <h2 data-testid="verdict-headline" className="text-2xl font-semibold tracking-tight">
          {headline}
        </h2>
        <p className="text-muted-foreground max-w-[580px] text-sm leading-[22px] text-pretty">
          {detail}
        </p>
      </div>

      <ScanFailureReason nodes={nodes} summary={summary} guidance={guidance} />

      <div className="flex items-center gap-2.5">
        <Button onClick={onRetry} disabled={retrying}>
          {retrying ? 'Trying…' : 'Try again'}
        </Button>
        <Button variant="outline" asChild>
          <Link to="/settings">Connection settings</Link>
        </Button>
      </div>

      {sources.length > 0 ? (
        <div className="bg-card flex items-center gap-4 rounded-full border px-[18px] py-2.5">
          <SourceDots sources={sources} />
        </div>
      ) : null}

      {caption === null ? null : (
        <p
          data-testid="failed-scan-sources"
          className="text-muted-foreground/75 text-xs leading-[18px]"
        >
          {caption}
        </p>
      )}
    </section>
  );
}
