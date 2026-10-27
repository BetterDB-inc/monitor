import { Download } from 'lucide-react';
import type { SessionDetail } from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { formatBytes } from '../../../lib/utils';
import { KeyPanel } from './KeyPanel';
import { MessageTimeline } from './MessageTimeline';
import { formatTtl } from './format';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function incompleteReasons(detail: SessionDetail): string[] {
  const reasons: string[] = [];
  if (detail.unparsedKeys > 0) {
    reasons.push(`${plural(detail.unparsedKeys, 'key')} could not be parsed`);
  }
  if (detail.keys.some((k) => k.truncated)) reasons.push('some values were cut at the size cap');
  if (detail.truncated) reasons.push('the session has more keys than were read');
  if (detail.failedNodes > 0) reasons.push(`${plural(detail.failedNodes, 'node')} did not respond`);
  if (detail.missingKeys > 0) {
    reasons.push(`${plural(detail.missingKeys, 'key')} vanished before it could be read`);
  }
  return reasons;
}

interface Props {
  detail: SessionDetail;
  onExport: () => void;
  exporting: boolean;
}

export function SessionDetailPanel({ detail, onExport, exporting }: Props) {
  const reasons = detail.complete ? [] : incompleteReasons(detail);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="break-all font-mono text-base">{detail.sessionId}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            ~{detail.estimatedTokens.toLocaleString()} tokens · {formatBytes(detail.memoryBytes)} ·{' '}
            TTL {formatTtl(detail.ttlMs)} · {plural(detail.keys.length, 'key')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onExport} disabled={exporting}>
          <Download className="h-4 w-4" aria-hidden />
          Export JSON
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!detail.complete && (
          <Alert variant="destructive">
            <AlertTitle>Timeline incomplete</AlertTitle>
            <AlertDescription>
              {reasons.length > 0 ? `${reasons.join('; ')}.` : 'Some keys were not read.'} Check the
              raw view of each key below.
            </AlertDescription>
          </Alert>
        )}
        {detail.touchesKeys && (
          <Alert>
            <AlertDescription>
              This server could not read without touching keys (CLIENT NO-TOUCH needs Valkey or
              Redis 7.2+), so viewing this session reset the idle time and access frequency of its
              keys.
            </AlertDescription>
          </Alert>
        )}
        <section>
          <h3 className="mb-2 text-sm font-medium">Timeline</h3>
          <MessageTimeline messages={detail.messages} />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Keys</h3>
          {detail.keys.map((view) => (
            <KeyPanel key={view.key} view={view} />
          ))}
        </section>
      </CardContent>
    </Card>
  );
}
