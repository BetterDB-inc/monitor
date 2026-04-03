import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Trash2, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useCliHistory } from '@/hooks/useCliHistory';
import { useCliWebSocket, type CliServerMessage } from '@/hooks/useCliWebSocket';
import { useConnection } from '@/hooks/useConnection';
import type { CliResultType } from '@betterdb/shared';

interface CliOutputEntry {
  id: string;
  command: string;
  result: string;
  resultType: CliResultType;
  durationMs: number;
  timestamp: number;
}

interface CliSystemMessage {
  id: string;
  message: string;
  timestamp: number;
}

type CliEntry = CliOutputEntry | CliSystemMessage;

function isSystemMessage(entry: CliEntry): entry is CliSystemMessage {
  return 'message' in entry;
}

const MAX_ENTRIES = 500;

let entryCounter = 0;
function nextId(): string {
  return `cli-${Date.now()}-${entryCounter++}`;
}

const HELP_TEXT = `Available commands:
  help          — Show this help message
  clear / cls   — Clear the output
  history       — Show command history
  exit / quit   — Close the CLI panel

All other commands are sent to the connected Valkey/Redis server.
Keyboard shortcuts:
  Ctrl+\`        — Toggle CLI panel
  Ctrl+L        — Clear output
  Ctrl+C        — Clear current input
  Up/Down       — Navigate command history`;

interface CliPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export function CliPanel({ isOpen, onToggle, onClose }: CliPanelProps) {
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [input, setInput] = useState('');
  const pendingQueueRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const { currentConnection } = useConnection();
  const cliHistory = useCliHistory();

  const addSystemMessage = useCallback((message: string) => {
    setEntries((prev) => {
      const next = [...prev, { id: nextId(), message, timestamp: Date.now() }];
      if (next.length > MAX_ENTRIES) return next.slice(next.length - MAX_ENTRIES);
      return next;
    });
  }, []);

  const handleServerMessage = useCallback((msg: CliServerMessage) => {
    const command = pendingQueueRef.current.shift();
    if (!command) return;

    const entry: CliOutputEntry =
      msg.type === 'error'
        ? {
            id: nextId(),
            command,
            result: `(error) ${msg.error}`,
            resultType: 'error',
            durationMs: 0,
            timestamp: Date.now(),
          }
        : {
            id: nextId(),
            command,
            result: msg.result,
            resultType: msg.resultType,
            durationMs: msg.durationMs,
            timestamp: Date.now(),
          };

    setEntries((prev) => {
      const next = [...prev, entry];
      if (next.length > MAX_ENTRIES) return next.slice(next.length - MAX_ENTRIES);
      return next;
    });
  }, []);

  const { send, isConnected } = useCliWebSocket({
    connectionId: currentConnection?.id ?? null,
    enabled: isOpen,
    onMessage: handleServerMessage,
  });

  // Clear pending command if connection drops mid-flight
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (prevConnectedRef.current && !isConnected && pendingQueueRef.current.length > 0) {
      const lost = pendingQueueRef.current.length;
      pendingQueueRef.current = [];
      addSystemMessage(`(error) Connection lost — ${lost} pending command(s) may have been lost`);
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected, addSystemMessage]);

  // Auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  // Auto-focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to allow the collapsible animation to complete
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const clearOutput = useCallback(() => {
    setEntries([]);
  }, []);

  const handleBuiltinCommand = useCallback(
    (cmd: string): boolean => {
      const lower = cmd.trim().toLowerCase();
      if (lower === 'help') {
        addSystemMessage(HELP_TEXT);
        return true;
      }
      if (lower === 'clear' || lower === 'cls') {
        clearOutput();
        return true;
      }
      if (lower === 'history') {
        const hist = cliHistory.getHistory();
        if (hist.length === 0) {
          addSystemMessage('(empty history)');
        } else {
          addSystemMessage(hist.map((h, i) => `  ${String(i + 1).padStart(3)} ${h}`).join('\n'));
        }
        return true;
      }
      if (lower === 'exit' || lower === 'quit') {
        onClose();
        return true;
      }
      return false;
    },
    [addSystemMessage, clearOutput, cliHistory, onClose],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    cliHistory.addEntry(trimmed);
    cliHistory.resetNavigation();
    setInput('');

    if (handleBuiltinCommand(trimmed)) return;

    if (!isConnected) {
      addSystemMessage('(error) Not connected to server. Waiting for reconnection...');
      return;
    }

    pendingQueueRef.current.push(trimmed);
    send(trimmed);
  }, [input, cliHistory, handleBuiltinCommand, isConnected, addSystemMessage, send]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = cliHistory.navigateUp(input);
        if (prev !== null) setInput(prev);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = cliHistory.navigateDown();
        if (next !== null) setInput(next);
      } else if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        clearOutput();
      } else if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        setInput('');
        cliHistory.resetNavigation();
      }
    },
    [handleSubmit, cliHistory, input, clearOutput],
  );

  return (
    <Collapsible open={isOpen} onOpenChange={onToggle}>
      <div className="fixed bottom-0 left-64 right-0 z-30 border-t bg-card shadow-lg">
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              'flex w-full items-center gap-2 px-4 py-2 text-sm font-medium',
              'hover:bg-muted transition-colors',
            )}
          >
            <Terminal className="h-4 w-4" />
            <span>CLI</span>
            {isConnected && (
              <span className="h-2 w-2 rounded-full bg-green-500" title="Connected" />
            )}
            {!isConnected && isOpen && (
              <span className="h-2 w-2 rounded-full bg-red-500" title="Disconnected" />
            )}
            <span className="ml-auto">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex h-[30vh] min-h-[200px] max-h-[50vh] flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-1.5">
              {currentConnection && (
                <Badge variant="secondary" className="text-xs">
                  {currentConnection.name}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="icon-xs" onClick={clearOutput} title="Clear output">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={onClose} title="Close CLI">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <Separator />

            {/* Output */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto bg-zinc-900 p-3 font-mono text-xs text-zinc-300"
            >
              {entries.length === 0 && (
                <div className="text-zinc-500">
                  Type &quot;help&quot; to see available commands. Press Ctrl+` to toggle.
                </div>
              )}
              {entries.map((entry) => {
                if (isSystemMessage(entry)) {
                  return (
                    <div key={entry.id} className="whitespace-pre-wrap break-all text-zinc-400">
                      {entry.message}
                    </div>
                  );
                }
                return (
                  <div key={entry.id} className="mb-1">
                    <div className="text-zinc-500">
                      {'> '}
                      <span className="text-zinc-200">{entry.command}</span>
                      {entry.durationMs > 0 && (
                        <span className="ml-2 text-zinc-600">({entry.durationMs}ms)</span>
                      )}
                    </div>
                    <div
                      className={cn(
                        'whitespace-pre-wrap break-all',
                        entry.resultType === 'error' ? 'text-red-400' : 'text-zinc-300',
                      )}
                    >
                      {entry.result}
                    </div>
                  </div>
                );
              })}
            </div>

            <Separator />

            {/* Input */}
            <div className="flex items-center bg-zinc-900 px-3 py-2">
              <span className="font-mono text-xs text-zinc-500 mr-2">&gt;</span>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isConnected ? 'Enter command...' : 'Connecting...'}
                className="flex-1 bg-transparent font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
