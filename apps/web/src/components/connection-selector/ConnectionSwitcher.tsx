import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { Connection } from '../../hooks/useConnection';
import { cn } from '@/lib/utils';

interface ConnectionSwitcherProps {
  connections: Connection[];
  current: Connection | null | undefined;
  onSelect: (id: string) => void;
}

/**
 * Match on name and on `host:port`. An operator who remembers the port but not
 * the label is the case a scrolling dropdown serves worst, which is the whole
 * reason this replaced a plain Select.
 */
function matches(connection: Connection, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  const haystack = `${connection.name} ${connection.host}:${connection.port}`.toLowerCase();
  return haystack.includes(needle);
}

export function ConnectionSwitcher({ connections, current, onSelect }: ConnectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    return connections.filter((connection) => {
      return matches(connection, query);
    });
  }, [connections, query]);

  useEffect(() => {
    const active = listRef.current?.querySelectorAll('[role="option"]')[activeIndex];
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function handleSelect(id: string): void {
    onSelect(id);
    setOpen(false);
    setQuery('');
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => {
        return Math.min(index + 1, Math.max(filtered.length - 1, 0));
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => {
        return Math.max(index - 1, 0);
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const choice = filtered[activeIndex];
      if (choice === undefined) {
        return;
      }
      handleSelect(choice.id);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          // Without this, highlighting a later row and dismissing leaves the
          // highlight behind, so the next Enter selects a row the operator
          // never chose.
          setActiveIndex(0);
        }
      }}
    >
      <Popover.Trigger
        role="combobox"
        aria-expanded={open}
        className="w-full h-auto py-1.5 px-3 text-sm flex items-center justify-between gap-2 rounded-md border border-input bg-transparent hover:bg-accent/50"
      >
        <span className="flex items-center gap-2 min-w-0">
          {current ? (
            <>
              <span
                data-testid={`conn-status-trigger`}
                data-connected={String(current.isConnected)}
                className={cn(
                  'w-2 h-2 rounded-full flex-shrink-0',
                  current.isConnected ? 'bg-green-500' : 'bg-destructive',
                )}
              />
              <span className="truncate">{current.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Select connection</span>
          )}
        </span>
        <ChevronDownIcon className="w-4 h-4 opacity-50 flex-shrink-0" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[16rem] rounded-md border bg-popover text-popover-foreground shadow-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <SearchIcon className="w-4 h-4 opacity-50 flex-shrink-0" />
            <input
              ref={searchRef}
              role="searchbox"
              aria-label="Search connections"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // The highlight indexes into the FILTERED list, so it must come
                // back into range whenever the filter changes — otherwise Enter
                // selects a row the operator cannot see.
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search by name or host:port"
              className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                {connections.length === 0
                  ? 'No connections yet.'
                  : 'No connections match that search.'}
              </p>
            ) : (
              filtered.map((connection, index) => {
                const isCurrent = connection.id === current?.id;
                return (
                  <button
                    key={connection.id}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelect(connection.id)}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left',
                      index === activeIndex && 'bg-accent',
                    )}
                  >
                    <span
                      data-testid={`conn-status-${connection.id}`}
                      data-connected={String(connection.isConnected)}
                      className={cn(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        connection.isConnected ? 'bg-green-500' : 'bg-destructive',
                      )}
                    />
                    <span className="truncate">{connection.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
                      {connection.host}:{connection.port}
                    </span>
                    {isCurrent ? <CheckIcon className="w-4 h-4 flex-shrink-0" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
