import type { ParsedMessage } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { prettyArgs } from './format';

function ToolCalls({ calls }: { calls: NonNullable<ParsedMessage['toolCalls']> }) {
  return (
    <div className="mt-2 space-y-2">
      {calls.map((call, i) => (
        <div
          key={call.id ?? i}
          data-testid={`tool-call-${call.id ?? i}`}
          className="rounded border bg-muted/40 p-2"
        >
          <div className="text-xs font-medium">
            Tool call: <span className="font-mono">{call.name}</span>
          </div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{prettyArgs(call.args)}</pre>
        </div>
      ))}
    </div>
  );
}

function InterruptEntry({ index, text }: { index: number; text: string }) {
  return (
    <li
      data-testid={`interrupt-${index}`}
      className="rounded-md border border-dashed border-amber-500/60 bg-amber-500/5 p-3"
    >
      <div className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        Waiting for input
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
    </li>
  );
}

export function MessageTimeline({ messages }: { messages: ParsedMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No messages.</p>;
  }
  const entries = messages.filter((m) => m.role !== 'interrupt');
  const interrupts = messages.filter((m) => m.role === 'interrupt');
  return (
    <ol className="space-y-3">
      {entries.map((m, i) => (
        <li key={i} className="rounded-md border p-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">{m.role}</Badge>
            {m.toolResult?.name && (
              <span className="font-mono text-xs text-muted-foreground">{m.toolResult.name}</span>
            )}
            {m.timestamp && <span className="text-xs text-muted-foreground">{m.timestamp}</span>}
          </div>
          {m.content !== '' && <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>}
          {m.toolCalls && m.toolCalls.length > 0 && <ToolCalls calls={m.toolCalls} />}
        </li>
      ))}
      {interrupts.map((m, i) => (
        <InterruptEntry key={`interrupt-${i}`} index={i} text={m.content} />
      ))}
    </ol>
  );
}
