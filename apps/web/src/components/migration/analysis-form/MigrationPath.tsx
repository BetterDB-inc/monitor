import type { MigrationDirection } from './preflight';

interface Props {
  direction: MigrationDirection | null;
}

const QUALIFIER: Record<MigrationDirection['kind'], string> = {
  'engine-change': 'engine change',
  'version-upgrade': 'version upgrade',
  'version-downgrade': 'version downgrade',
  identical: 'same engine and version',
};

export function MigrationPath({ direction }: Props) {
  if (direction === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4">
        <div className="h-px w-full bg-border" />
        <span className="text-xs text-muted-foreground">pick both endpoints</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4">
      <span className="text-center text-xs font-semibold">{direction.label}</span>
      <div className="relative h-px w-full bg-gradient-to-r from-border via-primary to-border">
        <span
          aria-hidden="true"
          className="absolute -top-[4px] -right-px size-0 border-y-4 border-l-8 border-y-transparent border-l-primary"
        />
      </div>
      <span className="text-center text-xs text-muted-foreground">{QUALIFIER[direction.kind]}</span>
    </div>
  );
}
