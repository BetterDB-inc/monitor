import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'examples',
]);

export function sourceFiles(dir, extensions, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        sourceFiles(path, extensions, found);
      }
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(path);
    }
  }
  return found;
}
