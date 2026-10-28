import type { ParsedMessage } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { CollapsibleText } from './CollapsibleText';
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
          <CollapsibleText
            as="pre"
            text={prettyArgs(call.args)}
            className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs"
          />
        </div>
      ))}
    </div>
  );
}

export function MessageTimeline({ messages }: { messages: ParsedMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No messages.</p>;
  }
  return (
    <ol className="space-y-3">
      {messages.map((m, i) => (
        <li key={i} className="rounded-md border p-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">{m.role}</Badge>
            {m.toolResult?.name && (
              <span className="font-mono text-xs text-muted-foreground">{m.toolResult.name}</span>
            )}
            {m.timestamp && <span className="text-xs text-muted-foreground">{m.timestamp}</span>}
          </div>
          {m.content !== '' && (
            <CollapsibleText text={m.content} className="whitespace-pre-wrap break-words text-sm" />
          )}
          {m.toolCalls && m.toolCalls.length > 0 && <ToolCalls calls={m.toolCalls} />}
        </li>
      ))}
    </ol>
  );
}
