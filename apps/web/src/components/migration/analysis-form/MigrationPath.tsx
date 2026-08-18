import type { MigrationDirection } from './preflight';

interface Props {
  direction: MigrationDirection | null;
  endpointsChosen: boolean;
}

const QUALIFIER: Record<MigrationDirection['kind'], string> = {
  'engine-change': 'engine change',
  'version-upgrade': 'version upgrade',
  'version-downgrade': 'version downgrade',
  identical: 'same engine and version',
};

export function MigrationPath({ direction, endpointsChosen }: Props) {
  if (direction === null && endpointsChosen === false) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4">
        <div className="h-px w-full bg-border" />
        <span className="text-xs text-muted-foreground">pick both endpoints</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4">
      <span className="text-center text-xs font-semibold">
        {direction === null ? 'Migration path' : direction.label}
      </span>
      <div className="relative h-px w-full bg-gradient-to-r from-border via-primary to-border">
        <span
          aria-hidden="true"
          className="absolute -top-[4px] -right-px size-0 border-y-4 border-l-8 border-y-transparent border-l-primary"
        />
      </div>
      <span className="text-center text-xs text-muted-foreground">
        {direction === null ? 'engine details unavailable' : QUALIFIER[direction.kind]}
      </span>
    </div>
  );
}
