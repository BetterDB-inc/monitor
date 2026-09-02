interface DriftBannerProps {
  versions: string[];
  nodeCount: number;
}

const NUMBER_WORD: Record<number, string> = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };

export function DriftBanner({ versions, nodeCount }: DriftBannerProps) {
  const word = NUMBER_WORD[versions.length] ?? `${versions.length}`;

  return (
    <p
      data-testid="drift-banner"
      className="border-chart-warning text-foreground rounded-lg border p-4 text-sm"
    >
      {word} versions across {nodeCount} nodes: {versions.join(', ')}. A mixed-version cluster
      usually means a rolling upgrade stalled - each node is matched against its own version below.
    </p>
  );
}
