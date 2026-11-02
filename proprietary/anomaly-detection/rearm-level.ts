export function rearmLevel<Level extends string>(
  rank: Record<Level, number>,
  previous: Level,
  read: () => Level,
  write: (level: Level) => void,
): () => void {
  return () => {
    if (rank[previous] < rank[read()]) write(previous);
  };
}
