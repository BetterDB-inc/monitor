import { useEffect, useRef, useCallback } from 'react';

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        tabIndex={-1}
        className="bg-background border rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Feedback</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">&times;</button>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-1">Found a bug?</p>
            <a
              href="https://github.com/BetterDB-inc/monitor/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline"
            >
              Open a GitHub issue
            </a>
            <p className="text-xs text-muted-foreground mt-0.5">bugs, unexpected behavior</p>
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Missing something?</p>
            <a
              href="https://calendar.app.google/kVpkQMMGF5VGQRds5"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline"
            >
              Book 15 min with Kristiyan
            </a>
            <p className="text-xs text-muted-foreground mt-1">
              Prefer email?{' '}
              <a href="mailto:kristiyan@betterdb.com" className="hover:underline">kristiyan@betterdb.com</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
