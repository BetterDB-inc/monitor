import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  // Arrow keys scroll the list, so the browser fires mouseenter on whatever row
  // slides under a motionless pointer. Honouring that would yank the highlight
  // away from where the keyboard is, on exactly the long lists this exists for.
  const keyboardNav = useRef(false);
  // Position, not just the event: scrolling under a stationary cursor can emit
  // mousemove without the pointer going anywhere, and treating that as intent
  // hands the highlight straight back to the row that slid underneath.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const optionIdPrefix = useId();

  const filtered = useMemo(() => {
    return connections.filter((connection) => {
      return matches(connection, query);
    });
  }, [connections, query]);

  // Derived rather than corrected in an effect: `connections` can change under
  // an open popover (refreshConnections lands whenever it lands), and an index
  // left pointing past the end makes Enter silently do nothing.
  const effectiveIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);
  const activeOptionId =
    effectiveIndex >= 0 ? `${optionIdPrefix}-option-${effectiveIndex}` : undefined;

  useEffect(() => {
    if (effectiveIndex < 0) {
      return;
    }
    const active = listRef.current?.querySelectorAll('[role="option"]')[effectiveIndex];
    active?.scrollIntoView({ block: 'nearest' });
  }, [effectiveIndex, open, filtered]);

  function handleSelect(id: string): void {
    onSelect(id);
    setOpen(false);
    setQuery('');
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      keyboardNav.current = true;
      // From the clamped position, not the raw one: after the list shrinks
      // they diverge, and stepping from the raw index leaves the visible
      // highlight motionless while state catches up.
      setActiveIndex(Math.min(effectiveIndex + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      keyboardNav.current = true;
      setActiveIndex(Math.max(effectiveIndex - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const choice = filtered[effectiveIndex];
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
          // Grows with its rows rather than being pinned to the trigger, the way
          // the Manage Connections list does — a hosted `host:port` is far wider
          // than the sidebar. Floored at the trigger so it never looks detached,
          // capped at whatever the viewport leaves so it cannot run off-screen.
          className="z-50 w-auto min-w-[max(16rem,var(--radix-popover-trigger-width))] max-w-[min(32rem,var(--radix-popover-content-available-width))] rounded-md border bg-popover text-popover-foreground shadow-md"
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
              aria-controls={`${optionIdPrefix}-listbox`}
              aria-activedescendant={activeOptionId}
              onChange={(event) => {
                setQuery(event.target.value);
                keyboardNav.current = true;
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

          <div
            ref={listRef}
            id={`${optionIdPrefix}-listbox`}
            role="listbox"
            className="max-h-64 overflow-y-auto p-1"
            onMouseMove={(event) => {
              const previous = lastPointer.current;
              const moved =
                previous === null || previous.x !== event.clientX || previous.y !== event.clientY;
              lastPointer.current = { x: event.clientX, y: event.clientY };
              if (moved && previous !== null) {
                keyboardNav.current = false;
              }
            }}
          >
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
                    id={`${optionIdPrefix}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onMouseEnter={() => {
                      if (keyboardNav.current) {
                        return;
                      }
                      setActiveIndex(index);
                    }}
                    onClick={() => handleSelect(connection.id)}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left',
                      index === effectiveIndex && 'bg-accent',
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
                    {/* `truncate` sets overflow:hidden, which drops a flex
                        item's automatic minimum size to zero: the name would
                        collapse to nothing while an unshrinkable host kept its
                        full width and pushed the row into a horizontal scroll.
                        Both shrink now, in proportion to their length, so the
                        long hosted URL gives ground before the name does. */}
                    <span className="min-w-0 truncate">{connection.name}</span>
                    <span className="ml-auto min-w-0 truncate ps-2 text-xs text-muted-foreground">
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
