import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, ChevronUp, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
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

const MIN_PANEL_HEIGHT = 200;
const MAX_PANEL_HEIGHT_RATIO = 0.7;
const DEFAULT_PANEL_HEIGHT = Math.round(window.innerHeight * 0.3);

export function CliPanel({ isOpen, onToggle, onClose }: CliPanelProps) {
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [input, setInput] = useState('');
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const pendingQueueRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const isDraggingRef = useRef(false);

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
  }, [entries]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      const startY = e.clientY;
      const startHeight = panelHeight;

      const onMove = (ev: PointerEvent): void => {
        const maxHeight = Math.round(window.innerHeight * MAX_PANEL_HEIGHT_RATIO);
        const delta = startY - ev.clientY;
        setPanelHeight(Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, startHeight + delta)));
      };

      const onUp = (): void => {
        isDraggingRef.current = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [panelHeight],
  );

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
      <div className="fixed bottom-0 left-64 right-0 z-30 bg-card shadow-lg">
        {/* Drag handle for resizing */}
        {isOpen && (
          <div
            onPointerDown={handleResizeStart}
            className="flex h-1 cursor-ns-resize items-center justify-center border-t hover:bg-primary/20 active:bg-primary/30"
          >
            <div className="h-0.5 w-8  bg-border" />
          </div>
        )}
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              'flex w-full items-center gap-2 px-4 py-2 text-sm font-medium bg-accent/50',
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
          <div className="flex flex-col" style={{ height: panelHeight }}>
            {/* Output */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto bg-accent p-3 font-mono text-xs text-accent-foreground"
            >
              {entries.length === 0 && (
                <div className="text-accent-foreground/70">
                  Type &quot;help&quot; to see available commands. Press Ctrl+` to toggle.
                </div>
              )}
              {entries.map((entry) => {
                if (isSystemMessage(entry)) {
                  return (
                    <div
                      key={entry.id}
                      className="whitespace-pre-wrap break-all text-accent-foreground/70"
                    >
                      {entry.message}
                    </div>
                  );
                }
                return (
                  <div key={entry.id} className="mb-1">
                    <div className="pb-2 font-bold text-accent-foreground/70">
                      {'> '}
                      <span>{entry.command}</span>
                      {entry.durationMs > 0 && (
                        <span className="ml-2 text-accent-foreground/80">
                          ({entry.durationMs}ms)
                        </span>
                      )}
                    </div>
                    <div
                      className={cn('whitespace-pre-wrap break-all p-1 pr-8 rounded', {
                        'text-destructive-foreground bg-destructive/90 ':
                          entry.resultType === 'error',
                      })}
                    >
                      {entry.result}
                    </div>
                  </div>
                );
              })}
            </div>

            <Separator />

            {/* Input */}
            <div className="flex items-center px-3 py-2">
              <span className="font-mono text-xs  mr-2">&gt;</span>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isConnected ? 'Enter command...' : 'Connecting...'}
                className="flex-1  font-mono text-xs  outline-none "
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
