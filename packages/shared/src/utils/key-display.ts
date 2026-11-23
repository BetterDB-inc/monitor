export const KEY_NAME_DISPLAY_LIMIT = 64;

const UNSAFE_IN_DISPLAY = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}"\\]/gu;

export function displayKeyName(name: string): string {
  const points = Array.from(name);
  const cut = points.length > KEY_NAME_DISPLAY_LIMIT;
  const kept = cut ? points.slice(0, KEY_NAME_DISPLAY_LIMIT).join('') : name;
  const shown = kept.replace(UNSAFE_IN_DISPLAY, (char) => {
    if (char === '"' || char === '\\') return `\\${char}`;
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex}}`;
  });
  return cut ? `${shown}…` : shown;
}
