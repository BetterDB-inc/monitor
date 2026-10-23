const GLOB_SPECIAL = /[\\*?[\]]/g;

export const escapeGlob = (value: string): string =>
  value.replace(GLOB_SPECIAL, (c) => `\\${c}`);
