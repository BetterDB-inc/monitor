// The spellings every BetterDB env flag treats as an explicit "off": the
// literal false/0 plus the human no/off. Trimmed and case-folded so a compose
// file's ` Off ` reads the same as `off`. Kept in one place so the flags that
// consult it (CLOUD_MODE, BETTERDB_TELEMETRY) can't drift into recognizing
// different negatives — adding a spelling here reaches every caller at once.
const NEGATIVE_ENV_VALUES = new Set(['false', '0', 'no', 'off']);

export function isNegativeEnvValue(value: string | undefined | null): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && NEGATIVE_ENV_VALUES.has(v);
}
