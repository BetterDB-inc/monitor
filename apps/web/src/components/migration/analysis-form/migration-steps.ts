export interface MigrationStep {
  title: string;
  body: string;
}

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    title: 'Configure',
    body: 'Pick the instance to copy from and the one to copy to. They must be different, and the target has to accept writes.',
  },
  {
    title: 'Analyse',
    body: 'We sample keys with SCAN and report size, data types, TTLs and anything the target handles differently. Nothing is modified.',
  },
  {
    title: 'Migrate',
    body: 'Review the findings, then approve the copy. Nothing moves until you do.',
  },
  {
    title: 'Verify',
    body: 'Compare source and target once the copy finishes, to confirm the keys arrived intact.',
  },
] as const;
