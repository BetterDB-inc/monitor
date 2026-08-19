import { useEffect, useRef } from 'react';

interface Props {
  logs: string[];
  /** Durable job-level notices, rendered as a persistent banner above the pane. */
  notices?: string[];
}

export function ExecutionLogViewer({ logs, notices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  // Notices live outside the scrolling, autoscrolling, cap-rolled log pane so they
  // stay visible for the whole run — merging them into `logs` let the pane's
  // slice(-500) + autoscroll evict them.
  const noticeBanner = notices && notices.length > 0 && (
    <div className="mb-2 space-y-1">
      {notices.map((notice, i) => (
        <div
          key={i}
          className="bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300 rounded-lg px-3 py-2 text-xs"
        >
          {notice}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {noticeBanner}
      {logs.length === 0 ? (
        <div className="bg-zinc-900 text-zinc-500 rounded-lg p-4 font-mono text-xs h-64 flex items-center justify-center">
          Waiting for output...
        </div>
      ) : (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="bg-zinc-900 text-zinc-300 rounded-lg p-4 font-mono text-xs h-64 overflow-y-auto"
        >
          {logs.slice(-500).map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
