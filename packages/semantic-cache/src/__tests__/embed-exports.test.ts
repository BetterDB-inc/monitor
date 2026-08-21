import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(__dirname, '../..');

function embedProviders(): string[] {
  return readdirSync(resolve(packageRoot, 'src/embed'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .filter((name) => name !== 'index' && name.startsWith('_') === false)
    .sort();
}

function packageExports(): Record<string, Record<string, string>> {
  const raw = readFileSync(resolve(packageRoot, 'package.json'), 'utf8');
  return JSON.parse(raw).exports;
}

describe('embed provider exports', () => {
  it('declares a subpath for every provider module', () => {
    const exportsMap = packageExports();
    const unreachable = embedProviders().filter((name) => {
      return Object.hasOwn(exportsMap, `./embed/${name}`) === false;
    });

    // An exports map is restrictive: a provider missing from it ships in the
    // tarball but cannot be imported. That shipped for embed/google.
    expect(unreachable).toEqual([]);
  });

  it('points each provider subpath at its own build output', () => {
    const exportsMap = packageExports();
    for (const name of embedProviders()) {
      expect(exportsMap[`./embed/${name}`]).toEqual({
        import: `./dist/embed/${name}.js`,
        require: `./dist/embed/${name}.js`,
        types: `./dist/embed/${name}.d.ts`,
      });
    }
  });
});
