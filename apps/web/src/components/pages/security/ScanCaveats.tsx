import type { ScanCaveat } from './scan-completeness';

interface ScanCaveatsProps {
  caveats: ScanCaveat[];
}

export function ScanCaveats({ caveats }: ScanCaveatsProps) {
  if (caveats.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="scan-caveats"
      role="status"
      aria-label="Scan completeness"
      className="border-chart-warning text-foreground space-y-2 rounded-lg border p-4 text-sm"
    >
      <p className="font-medium">
        This scan is incomplete - the counts below are a floor, not an all-clear.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {caveats.map((entry) => {
          return (
            <li key={entry.id} data-testid={`scan-caveat-${entry.id}`}>
              {entry.text}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
