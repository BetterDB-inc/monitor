/** Escape a string for safe use as a Valkey Search TAG filter value.
 * Spaces are included because Valkey Search treats unescaped spaces as term
 * separators (OR semantics), which would broaden the filter unintentionally.
 */
export function escapeTag(value: string): string {
  return value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\ ]/g, '\\$&');
}
