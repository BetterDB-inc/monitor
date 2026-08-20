import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const CHILDREN = [
  { ns: 'agentCache', pkg: '@betterdb/agent-cache', dir: 'agent-cache' },
  { ns: 'semanticCache', pkg: '@betterdb/semantic-cache', dir: 'semantic-cache' },
  { ns: 'retrieval', pkg: '@betterdb/retrieval', dir: 'retrieval' },
  { ns: 'memory', pkg: '@betterdb/agent-memory', dir: 'agent-memory' },
  { ns: 'searchKit', pkg: '@betterdb/valkey-search-kit', dir: 'valkey-search-kit' },
];

const FACADE = resolve(__dirname, '../index.ts');

// Child subpaths that deliberately have no facade mirror, each with a reason.
// A future subpath added to a child's `exports` map that isn't handled here
// fails the `mirrors every child subpath export` test below instead of
// silently going unreachable through the facade.
const SUBPATH_EXCLUSIONS: Record<string, Record<string, string>> = {
  'agent-cache': {
    './ai': 'renamed to the facade ./vercel subpath',
  },
  'semantic-cache': {
    './ai': 'renamed to the facade ./vercel subpath',
  },
};

let checker: ts.TypeChecker;
let program: ts.Program;

function dtsFor(dir: string): string {
  return resolve(__dirname, `../../../${dir}/dist/index.d.ts`);
}

function exportsOf(fileName: string): Map<string, string> {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`not in program: ${fileName}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`no module symbol: ${fileName}`);
  }
  const result = new Map<string, string>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    result.set(symbol.name, target.declarations?.[0]?.getSourceFile().fileName ?? '?');
  }
  return result;
}

beforeAll(() => {
  program = ts.createProgram([FACADE, ...CHILDREN.map((c) => dtsFor(c.dir))], {
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    skipLibCheck: true,
  });
  checker = program.getTypeChecker();
});

function declarationSites(): Map<string, Set<string>> {
  const sites = new Map<string, Set<string>>();
  for (const child of CHILDREN) {
    for (const [name, decl] of exportsOf(dtsFor(child.dir))) {
      if (!sites.has(name)) {
        sites.set(name, new Set());
      }
      sites.get(name)?.add(decl);
    }
  }
  return sites;
}

describe('@betterdb/ai export completeness', () => {
  it('exports all five namespaces', () => {
    const facadeExports = exportsOf(FACADE);
    for (const child of CHILDREN) {
      expect(facadeExports.has(child.ns)).toBe(true);
    }
  });

  it('flattens every unambiguous child export', () => {
    const facadeExports = exportsOf(FACADE);
    const sites = declarationSites();
    const unreachable: string[] = [];

    for (const child of CHILDREN) {
      for (const name of exportsOf(dtsFor(child.dir)).keys()) {
        const isAmbiguous = (sites.get(name)?.size ?? 0) > 1;
        if (!isAmbiguous && !facadeExports.has(name)) {
          unreachable.push(`${child.pkg}#${name}`);
        }
      }
    }

    // Ambiguous names are deliberately namespace-only; they stay reachable as
    // `facade.<ns>.<name>` and are covered by the namespace test above.
    expect(unreachable).toEqual([]);
  });

  it('never flattens a name declared in more than one place', () => {
    const sites = declarationSites();
    const shadowed = [...exportsOf(FACADE).keys()].filter((name) => {
      return (sites.get(name)?.size ?? 0) > 1;
    });

    expect(shadowed).toEqual([]);
  });

  it('declares every adapter subpath in package.json exports', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    for (const sub of [
      '.',
      './langchain',
      './langgraph',
      './vercel',
      './openai',
      './openai-responses',
      './anthropic',
      './llamaindex',
    ]) {
      expect(pkg.exports).toHaveProperty([sub]);
    }
  });

  it('mirrors every child subpath export', () => {
    const facadePkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    const facadeSubpaths = new Set(Object.keys(facadePkg.exports ?? {}));
    const unreachable: string[] = [];

    for (const child of CHILDREN) {
      const childPkg = JSON.parse(
        readFileSync(resolve(__dirname, `../../../${child.dir}/package.json`), 'utf8'),
      );
      const exclusions = SUBPATH_EXCLUSIONS[child.dir] ?? {};

      for (const subpath of Object.keys(childPkg.exports ?? {})) {
        if (subpath === '.') {
          continue;
        }
        if (subpath in exclusions) {
          continue;
        }
        if (!facadeSubpaths.has(subpath)) {
          unreachable.push(`${child.pkg}${subpath}`);
        }
      }
    }

    expect(unreachable).toEqual([]);
  });
});
