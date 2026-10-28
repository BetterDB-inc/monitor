import { useId, useState } from 'react';
import type { KeyView } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { MessageTimeline } from './MessageTimeline';
import { formatTtl } from './format';

const binaryOf = (view: KeyView): string | null =>
  view.binary && typeof view.raw === 'string' ? view.raw : null;

function rawText(view: KeyView): string {
  const binary = binaryOf(view);
  if (binary !== null) return binary;
  const raw = view.raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
    return raw;
  }
  return JSON.stringify(raw, null, 2) ?? String(raw);
}

export function KeyPanel({ view, expanded = false }: { view: KeyView; expanded?: boolean }) {
  const [mode, setMode] = useState<'hidden' | 'structured' | 'raw'>(
    expanded ? (view.parsed ? 'structured' : 'raw') : 'hidden',
  );
  const labelId = useId();
  const showRaw = mode === 'raw' || (mode === 'structured' && !view.parsed);

  return (
    <section aria-labelledby={labelId} className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span id={labelId} className="break-all font-mono text-xs">
          {view.key}
        </span>
        <Badge variant="outline">{view.type}</Badge>
        <span className="text-xs text-muted-foreground">{formatTtl(view.ttlMs)}</span>
        {view.truncated && <Badge variant="warning">Truncated</Badge>}
        <div className="ms-auto flex gap-1">
          <Button
            size="sm"
            variant={mode === 'structured' ? 'secondary' : 'ghost'}
            aria-pressed={mode === 'structured'}
            disabled={!view.parsed}
            onClick={() => setMode('structured')}
          >
            Structured
          </Button>
          <Button
            size="sm"
            variant={showRaw ? 'secondary' : 'ghost'}
            aria-pressed={showRaw}
            onClick={() => setMode('raw')}
          >
            Raw
          </Button>
          {mode !== 'hidden' && (
            <Button size="sm" variant="ghost" onClick={() => setMode('hidden')}>
              Hide
            </Button>
          )}
        </div>
      </div>
      {!view.parsed && (
        <p className="mb-2 text-sm text-destructive">Not parsed: {view.reason}</p>
      )}
      {mode === 'hidden' ? null : showRaw ? (
        <>
          {binaryOf(view) !== null && (
            <p className="mb-1 text-xs text-muted-foreground">
              This value is not valid UTF-8, shown as base64.
            </p>
          )}
          <pre
            data-testid="raw-value"
            className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-xs"
          >
            {rawText(view)}
          </pre>
        </>
      ) : (
        view.parsed && <MessageTimeline messages={view.messages} />
      )}
    </section>
  );
}
