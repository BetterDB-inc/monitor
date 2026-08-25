import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useHotkeyRegistrations } from '@tanstack/react-hotkeys';
import { formatForDisplay, formatHotkeySequence } from '@tanstack/hotkeys';

const GROUP_ORDER = ['Navigation', 'Panels', 'View', 'Help'] as const;

interface Row {
  label: string;
  name: string;
}

/**
 * Reads the live registry rather than a hand-written list, so the sheet cannot
 * drift from what is actually bound — the failure mode of every shortcut table
 * maintained by hand. A binding with no `meta` shows as a gap rather than being
 * silently omitted.
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  const { hotkeys, sequences } = useHotkeyRegistrations();

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // The sheet lists the navigation chords, and those chords still fire while it
  // is open — leaving it covering the page the user just asked for.
  useEffect(() => {
    if (pathname === openedAt.current) {
      return;
    }
    onClose();
  }, [pathname, onClose]);

  const grouped = new Map<string, Row[]>();
  const unlabelled: Row[] = [];

  // Display strings are derived from the binding itself, so they cannot drift
  // from what fires — and `formatForDisplay` renders ⌘ on macOS and Ctrl
  // elsewhere, which a stored label could not do.
  for (const registration of hotkeys) {
    collect(registration.options?.meta, formatForDisplay(registration.hotkey));
  }
  for (const registration of sequences) {
    collect(registration.options?.meta, formatHotkeySequence(registration.sequence));
  }

  function collect(meta: { name?: string; group?: string } | undefined, label: string): void {
    const row = { label, name: meta?.name ?? '' };
    if (meta?.group === undefined || row.name === '') {
      unlabelled.push(row);
      return;
    }
    const rows = grouped.get(meta.group) ?? [];
    rows.push(row);
    grouped.set(meta.group, rows);
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="bg-background border rounded-lg shadow-lg w-full max-w-2xl mx-4 p-6 outline-none max-h-[80vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {GROUP_ORDER.map((group) => {
            const rows = grouped.get(group) ?? [];
            if (rows.length === 0) {
              return null;
            }
            return (
              <section key={group}>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  {group}
                </h3>
                <ul className="space-y-1">
                  {rows.map((row) => (
                    <li key={row.label} className="flex items-baseline justify-between gap-4">
                      <span className="text-sm">{row.name}</span>
                      <kbd className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                        {row.label}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        {unlabelled.length > 0 && (
          <p className="mt-6 text-xs text-muted-foreground">
            {unlabelled.length} binding(s) registered without a name or group and are not listed.
          </p>
        )}
      </div>
    </div>
  );
}
