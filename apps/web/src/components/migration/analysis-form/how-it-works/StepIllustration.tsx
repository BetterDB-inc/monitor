interface Props {
  step: number;
}

const CELL = 8;
const GAP = 4;
const PITCH = CELL + GAP;

const DENSITY = [0.9, 0.55, 0.8, 0.45, 0.7, 0.95, 0.5, 0.85, 0.6, 0.75, 0.4, 0.9];
const SAMPLED = [1, 4, 9, 12, 17, 21, 26, 30];

interface Cell {
  x: number;
  y: number;
  index: number;
}

function grid(cols: number, rows: number): Cell[] {
  const out: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({ x: col * PITCH, y: row * PITCH, index: row * cols + col });
    }
  }
  return out;
}

function StoredKeys({ cells }: { cells: Cell[] }) {
  return (
    <>
      {cells.map((cell) => {
        return (
          <rect
            key={cell.index}
            x={cell.x}
            y={cell.y}
            width={CELL}
            height={CELL}
            rx={2}
            fill="var(--primary)"
            opacity={DENSITY[cell.index % DENSITY.length]}
          />
        );
      })}
    </>
  );
}

function EmptySlots({ cells }: { cells: Cell[] }) {
  return (
    <>
      {cells.map((cell) => {
        return (
          <rect
            key={cell.index}
            x={cell.x}
            y={cell.y}
            width={CELL}
            height={CELL}
            rx={2}
            fill="var(--muted-foreground)"
            fillOpacity={0.08}
            stroke="var(--border)"
          />
        );
      })}
    </>
  );
}

const SMALL = grid(4, 3);
const WIDE = grid(8, 4);

function Configure() {
  return (
    <>
      <g transform="translate(24 34)">
        <StoredKeys cells={SMALL} />
      </g>
      <g transform="translate(152 34)">
        <EmptySlots cells={SMALL} />
      </g>
      <path
        d="M78 50 H140"
        stroke="var(--muted-foreground)"
        opacity={0.5}
        strokeWidth={1.5}
        strokeDasharray="4 4"
        fill="none"
      />
      <path d="M140 46 L146 50 L140 54 Z" fill="var(--muted-foreground)" opacity={0.5} />
    </>
  );
}

function Analyse() {
  return (
    <>
      <g transform="translate(64 28)">
        {WIDE.map((cell) => {
          const isSampled = SAMPLED.includes(cell.index);
          if (isSampled) {
            return (
              <rect
                key={cell.index}
                x={cell.x}
                y={cell.y}
                width={CELL}
                height={CELL}
                rx={2}
                fill="var(--primary)"
              />
            );
          }
          return (
            <rect
              key={cell.index}
              x={cell.x}
              y={cell.y}
              width={CELL}
              height={CELL}
              rx={2}
              fill="var(--muted-foreground)"
              opacity={0.18}
            />
          );
        })}
      </g>
      <path
        d="M122 18 V82"
        stroke="var(--primary)"
        strokeWidth={1.5}
        strokeDasharray="3 3"
        fill="none"
        opacity={0.7}
      />
    </>
  );
}

function Migrate() {
  const arrived = SMALL.slice(0, 5);
  const pending = SMALL.slice(5);

  return (
    <>
      <g transform="translate(24 34)">
        <StoredKeys cells={SMALL} />
      </g>
      <g transform="translate(152 34)">
        <StoredKeys cells={arrived} />
        <EmptySlots cells={pending} />
      </g>
      <path
        d="M78 50 H140"
        stroke="var(--muted-foreground)"
        opacity={0.25}
        strokeWidth={1.5}
        fill="none"
      />
      <rect x={88} y={46} width={CELL} height={CELL} rx={2} fill="var(--primary)" opacity={0.9} />
      <rect x={104} y={46} width={CELL} height={CELL} rx={2} fill="var(--primary)" opacity={0.6} />
      <rect x={120} y={46} width={CELL} height={CELL} rx={2} fill="var(--primary)" opacity={0.3} />
      <path d="M140 46 L146 50 L140 54 Z" fill="var(--muted-foreground)" opacity={0.5} />
    </>
  );
}

function Verify() {
  const left = SMALL;
  const right = SMALL;

  return (
    <>
      <g transform="translate(24 34)">
        <StoredKeys cells={left} />
      </g>
      <g transform="translate(152 34)">
        <StoredKeys cells={right} />
      </g>
      <path
        d="M78 50 H140"
        stroke="var(--muted-foreground)"
        opacity={0.25}
        strokeWidth={1.5}
        fill="none"
      />
      <path
        d="M100 50 l5 5 l9 -11"
        stroke="var(--primary)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  );
}

export function StepIllustration({ step }: Props) {
  return (
    <svg viewBox="0 0 220 100" className="h-auto w-full max-w-[300px]" aria-hidden="true">
      {step === 0 && <Configure />}
      {step === 1 && <Analyse />}
      {step === 2 && <Migrate />}
      {step === 3 && <Verify />}
    </svg>
  );
}
