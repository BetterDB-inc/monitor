import { useEffect, useRef } from 'react';

interface Props {
  logs: string[];
}

export function ExecutionLogViewer({ logs }: Props) {
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

  if (logs.length === 0) {
    return (
      <div className="bg-zinc-900 text-zinc-500 rounded-lg p-4 font-mono text-xs h-64 flex items-center justify-center">
        Waiting for output...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="bg-zinc-900 text-zinc-300 rounded-lg p-4 font-mono text-xs h-64 overflow-y-auto"
    >
      {logs.slice(-500).map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
      ))}
    </div>
  );
}
