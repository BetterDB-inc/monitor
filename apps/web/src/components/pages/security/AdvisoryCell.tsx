import type { Advisory } from '@betterdb/shared';
import { advisoryHref } from './advisory-link';

interface AdvisoryCellProps {
  entry: Advisory;
}

export function AdvisoryCell({ entry }: AdvisoryCellProps) {
  const href = advisoryHref(entry);

  return (
    <div className="max-w-sm space-y-1">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium break-words underline underline-offset-2"
        >
          {entry.cveId}
        </a>
      ) : (
        <span className="font-medium break-words">{entry.cveId}</span>
      )}
      {entry.summary ? (
        <p className="text-muted-foreground line-clamp-2 text-xs break-words">{entry.summary}</p>
      ) : null}
    </div>
  );
}
