import type { FailedNode } from './scan-error';

interface ScanFailureReasonProps {
  nodes: FailedNode[];
  summary: string;
  guidance: string;
}

export function ScanFailureReason({ nodes, summary, guidance }: ScanFailureReasonProps) {
  if (nodes.length === 0) {
    return (
      <section
        data-testid="scan-failure-reason"
        className="border-destructive/50 bg-destructive/8 flex w-[660px] max-w-full flex-col gap-2.5 rounded-lg border p-4 text-left"
      >
        <p data-testid="scan-error" className="text-sm leading-[22px]">
          {summary}
        </p>
        <p className="text-muted-foreground text-[13px] leading-5 text-pretty">{guidance}</p>
      </section>
    );
  }

  return (
    <section
      data-testid="scan-failure-reason"
      className="border-destructive/50 bg-destructive/8 w-[660px] max-w-full overflow-hidden rounded-lg border text-left"
    >
      <div className="border-destructive/30 flex items-center justify-between gap-3 border-b px-[18px] py-2.5">
        <span className="text-muted-foreground text-xs font-semibold tracking-[0.06em] uppercase">
          Nodes not scanned
        </span>
        <span data-testid="scan-failure-count" className="text-muted-foreground text-xs">
          {nodes.length} of {nodes.length}
        </span>
      </div>
      <ul data-testid="not-scanned-list">
        {nodes.map((node) => {
          return (
            <li
              key={node.address}
              className="flex items-baseline gap-3.5 px-[18px] py-2.5 not-first:border-t not-first:border-white/7"
            >
              <span className="w-[150px] shrink-0 font-mono text-[13px]">{node.address}</span>
              <span className="text-muted-foreground flex-1 text-[13px] leading-5">
                {node.reason}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="border-destructive/30 text-muted-foreground border-t px-[18px] py-2.5 text-[13px] leading-5 text-pretty">
        {guidance}
      </p>
    </section>
  );
}
