export function resolveNext(next: string | null): string {
  if (next === null) {
    return '/';
  }
  if (next.startsWith('/') === false) {
    return '/';
  }
  if (next.startsWith('//') === true) {
    return '/';
  }
  if (next.includes('\\') === true) {
    return '/';
  }
  return next;
}
