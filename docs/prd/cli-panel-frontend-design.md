# CLI Panel — Frontend Component Design

## shadcn Components to Install

```bash
cd apps/web
pnpm dlx shadcn@latest add scroll-area tooltip collapsible separator
```

| Component | Usage |
|-----------|-------|
| **ScrollArea** | Output area — styled scrollbar, overflow handling |
| **Tooltip** | Toggle button label ("Toggle CLI (Ctrl+`)") |
| **Collapsible** | Panel expand/collapse with animation |
| **Separator** | Visual separator between panel header and output |
| **Button** | Already installed — toggle, clear, close buttons |
| **Badge** | Already installed — connection status indicator |

## Layout

```
+--sidebar (w-64)--+------- main content area (pl-64) --------+
|                  |                                            |
|  [nav items]     |  <Routes /> content                       |
|                  |                                            |
|                  |                                            |
|                  +--------------------------------------------+
|                  |  CLI Panel (Collapsible, 30vh when open)   |
|  [CLI toggle]    |  +--- header bar (h-9) ------------------+|
|  [Settings]      |  | > connection:Default | [Clear] [Close] ||
+------------------+  +----------------------------------------+|
                   |  | ScrollArea — output                     |
                   |  |  > PING                                 |
                   |  |  PONG                                   |
                   |  |  > SET foo bar                          |
                   |  |  OK                                     |
                   |  +----------------------------------------+|
                   |  | Separator                               |
                   |  | > [input________________________] Enter |
                   +--------------------------------------------+
```

When collapsed, only a 36px bar with a grip/chevron icon is visible at the bottom.

## Component Tree

```
AppLayout
  ├── <aside> (sidebar)
  │     ├── nav items...
  │     └── <CliToggleButton />          ← Button ghost + Tooltip
  │           icon: Terminal (lucide)
  │           tooltip: "Toggle CLI (Ctrl+`)"
  │
  ├── <main>
  │     └── <Routes />
  │
  └── <CliPanel />                       ← Collapsible.Root
        ├── <Collapsible.Trigger>        ← collapsed bar (click to expand)
        │     ├── GripHorizontal icon
        │     ├── "CLI" label
        │     ├── Badge (connection name)
        │     └── ChevronUp / ChevronDown
        │
        └── <Collapsible.Content>        ← animated expand
              ├── <CliPanelHeader />
              │     ├── Badge (connection name + status dot)
              │     ├── Button ghost icon-xs (Trash2 — clear output)
              │     └── Button ghost icon-xs (X — close panel)
              │
              ├── <Separator />
              │
              ├── <ScrollArea className="flex-1">
              │     └── <CliOutput entries={entries} />
              │           ├── <CliOutputEntry /> × N
              │           │     ├── <span className="text-muted-foreground">> </span>
              │           │     ├── <span className="text-primary">{command}</span>
              │           │     ├── <span className="text-green-500">{result}</span>  (or red for errors)
              │           │     └── <span className="text-muted-foreground text-xs">{durationMs}ms</span>
              │           └── auto-scroll ref
              │
              ├── <Separator />
              │
              └── <CliInput />
                    ├── <span className="text-muted-foreground font-mono">> </span>
                    └── <input
                          className="font-mono bg-transparent flex-1 outline-none"
                          onKeyDown={handleKeyDown}  ← Enter=submit, Up/Down=history
                        />
```

## Hooks

### useCliWebSocket(connectionId: string | null, enabled: boolean)

```typescript
interface UseCliWebSocketReturn {
  send: (command: string) => void;
  lastMessage: CliResultMessage | CliErrorMessage | null;
  isConnected: boolean;
}
```

- Builds WS URL: `${wsBase}/cli/ws` (derive from `API_BASE` — `ws://localhost:3001/cli/ws` in dev, `wss://${host}/api/cli/ws` in prod)
- Sends: `{ type: 'execute', command, connectionId }`
- Receives: result/error messages
- Auto-reconnects with exponential backoff (1s, 2s, 4s, max 10s)
- Closes on unmount or when `enabled` becomes false
- Reconnects when `connectionId` changes

### useCliHistory(maxSize = 100)

```typescript
interface UseCliHistoryReturn {
  history: string[];
  historyIndex: number;
  navigateUp: () => string | null;
  navigateDown: () => string | null;
  addEntry: (command: string) => void;
  resetNavigation: () => void;
}
```

- Up arrow: move back in history, return command string
- Down arrow: move forward, return empty string when past end
- Enter: adds command to history, resets navigation index
- Preserves current input while navigating (saved on first Up press)

### useCliPanel()

```typescript
interface UseCliPanelReturn {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}
```

- State persisted in `sessionStorage` under key `betterdb-cli-open`
- Registers global `Ctrl+`` keydown listener
- Provides context to both the sidebar toggle button and the panel

## Reference: VS Code Extension

Port from [`BetterDB-inc/vscode` CliTerminalProvider.ts](https://github.com/BetterDB-inc/vscode/blob/master/src/providers/CliTerminalProvider.ts):

### Client-side built-in commands (handled in frontend, not sent to server)
- `help` — show available commands and keyboard shortcuts
- `clear` / `cls` — clear output (same as Ctrl+L)
- `history` — show numbered command history list
- `exit` / `quit` — close the CLI panel

### Keyboard shortcuts
- `Up/Down` — navigate command history
- `Ctrl+L` — clear screen
- `Ctrl+C` — cancel current input, show new prompt
- `Enter` — submit command

### `parseCommandLine` logic
The VS Code extension has a state machine parser for splitting `SET "my key" "hello world"` into `['SET', 'my key', 'hello world']`. This same logic is used server-side in `command-parser.ts` (sub-issue 2). The frontend does NOT need its own parser — it sends the raw string to the backend.

## Existing Patterns to Reuse

| Pattern | Source | How to reuse |
|---------|--------|-------------|
| Log viewer with auto-scroll | `ExecutionLogViewer.tsx` | Same `isAtBottomRef` + `useEffect` scroll pattern for CLI output |
| Polling with backoff | `ExecutionPanel.tsx` | Same backoff pattern for WS reconnection |
| Keyboard listener | `EventTimeline.tsx` | Same `useEffect` + `window.addEventListener('keydown')` |
| API base URL derivation | `apps/web/src/api/client.ts` | Derive WS URL from `API_BASE` |
| Connection ID injection | `apps/web/src/api/client.ts` | Use `getCurrentConnectionId()` for WS messages |
| Icon usage | Throughout codebase | `import { Terminal, Trash2, X, ChevronUp } from 'lucide-react'` |
| `cn()` utility | `@/lib/utils` | For conditional class merging |

## Styling Details

- **Output area**: `bg-zinc-900 text-zinc-300 font-mono text-xs` (matches `ExecutionLogViewer`)
- **Panel background**: `bg-card border-t` (matches app theme)
- **Input**: `bg-transparent border-0 font-mono text-sm outline-none` with `focus:ring-0`
- **Commands** in output: `text-primary` (stands out)
- **Results**: `text-zinc-300` (normal), `text-destructive` (errors), `text-muted-foreground` (nil)
- **Duration**: `text-muted-foreground text-[10px]` aligned right
- **Panel height**: `h-[30vh]` when open, with `min-h-[200px]` and `max-h-[50vh]`
- **Transition**: Collapsible handles the open/close animation automatically

## Data Types

```typescript
interface CliOutputEntry {
  id: string;          // crypto.randomUUID() for React key
  command: string;
  result: string;
  resultType: 'string' | 'integer' | 'array' | 'nil' | 'error';
  durationMs: number;
  timestamp: number;
}

interface CliSystemMessage {
  id: string;
  message: string;     // e.g., "Switched to connection: Default"
  timestamp: number;
}

type CliEntry = CliOutputEntry | CliSystemMessage;
```

## Connection Switch Behavior

When `connectionId` changes (user switches in `ConnectionSelector`):
1. WS hook reconnects with new connectionId
2. System message appended: "Switched to connection: {name}"
3. Output is NOT cleared (user can scroll back to see previous connection's output)
