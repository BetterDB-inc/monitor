/**
 * Parses a command-line string into an array of arguments.
 * Handles double/single quoted strings and backslash escapes within quotes.
 *
 * Examples:
 *   'SET "my key" "hello world"' => ['SET', 'my key', 'hello world']
 *   "SET 'k' 'v'"               => ['SET', 'k', 'v']
 */
export function parseCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === '\\' && inQuotes && i + 1 < input.length) {
      escape = true;
      continue;
    }

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
