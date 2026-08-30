#!/usr/bin/env node
/**
 * Guards the canonical TTL bounds against mirror drift and literal drift.
 *
 * @betterdb/shared is private and never published, so @betterdb/semantic-cache,
 * @betterdb/mcp and the betterdb-semantic-cache wheel cannot import the
 * canonical constants — each keeps a mirror. This script reads the declared
 * value out of every one as source text, which is what lets a single check
 * cover TypeScript and Python alike with no build, no install and no test
 * runner in any package.
 *
 * Two things are checked:
 *
 *   1. Drift between declarations. Every declaration of TTL_SECONDS_MIN or
 *      TTL_SECONDS_MAX found anywhere in the tree must equal the canonical
 *      one. The set is discovered rather than listed, so a mirror added in a
 *      new package is covered the day it lands.
 *   2. Drift at the call sites. A bound applied to a TTL value must name a
 *      constant; a bare numeric literal in that position fails, which is what
 *      stops a schema quietly going back to a hand-typed ceiling.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one declaration every other declaration is measured against. */
const CANONICAL_FILE = 'packages/shared/src/utils/cache-proposals.ts';

const NAMES = ['TTL_SECONDS_MIN', 'TTL_SECONDS_MAX'];

/** Directories that never hold a declaration or a bound worth guarding. */
const SKIPPED_DIRS = new Set([
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

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.py', '.mjs', '.js'];

/**
 * Tests state the bounds as literals on purpose — they assert what the
 * constants are, so they cannot be written in terms of them.
 */
const TEST_PATH =
  /(^|\/)(__tests__|tests|test)(\/|$)|\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/;

/**
 * A TTL is compared against a literal for plenty of legitimate reasons — `ttl >
 * 0` for "has an expiry", `ttl < 3600` for "short-lived". Only two shapes
 * actually state the bound, and only those are guarded:
 *
 *   1. A schema field named for a TTL carrying a `.min()`/`.max()` or a
 *      pydantic `ge=`/`le=` bound. This is the `.max(9999)` regression.
 *   2. A two-sided range in a stretch of code that is handling a TTL, which is
 *      the runtime clamp. One-sided comparisons are left alone.
 */

/**
 * A schema field: `new_ttl_seconds: z…`, `ttl: Field(…)`, or the annotated
 * pydantic form `ttl_seconds: int = Field(…)`, which is the idiom the bare form
 * is the exception to. Which fields are a TTL's is decided by name afterwards,
 * because folding that into the pattern is what made a field simply called
 * `ttl_seconds` match nothing at all.
 */
const SCHEMA_FIELD = /^[ \t]*([A-Za-z_]\w*)\s*:\s*(?:z\b|(?:[^=\n]+=\s*)?\w*Field\()/gim;

/** A schema field name that denotes a TTL. */
const TTL_FIELD_NAME = /ttl/i;

/** Where a sibling schema field starts, and so the TTL field's bounds end. */
const NEXT_SCHEMA_FIELD = /\n[ \t]*[A-Za-z_]\w*\s*:\s*(?:z\b|(?:[^=\n]+=\s*)?\w*Field\()/;

/** Fallback span for a TTL field with no sibling after it. */
const SCHEMA_FIELD_SPAN = 400;

/**
 * Only a two-sided bound states the canonical range. A lone `.min(0)` on
 * `current_ttl_seconds`, or a lone `.min(1000)` on a `*_TTL_MS` env var, bounds
 * a different quantity and is none of this guard's business.
 */
const LOWER_BOUNDS = [/\.min\(\s*([^)]+?)\s*\)/g, /\b(?:ge|gt)\s*=\s*([^,)\s]+)/g];
const UPPER_BOUNDS = [/\.max\(\s*([^)]+?)\s*\)/g, /\b(?:le|lt)\s*=\s*([^,)\s]+)/g];

/** A two-sided range: the clamp shape, in either language. */
const RANGE_BOUNDS = [
  { pattern: /(\w+)\s*>=\s*(\d+)\s*&&\s*\1\s*<=\s*\w+/g },
  { pattern: /(\w+)\s*>=\s*\w+\s*&&\s*\1\s*<=\s*(\d+)/g },
  { pattern: /(\w+)\s*<=\s*(\d+)\s*&&\s*\1\s*>=\s*\w+/g },
  { pattern: /(\w+)\s*<=\s*\w+\s*&&\s*\1\s*>=\s*(\d+)/g },
  { pattern: /(\d+)\s*<=\s*\w+\s*<=\s*\w+/g },
  { pattern: /\w+\s*<=\s*\w+\s*<=\s*(\d+)/g },
];

/** How far back a TTL has to be mentioned for a range to be a TTL clamp. */
const CLAMP_WINDOW = 300;

/** A name that denotes a TTL. */
const TTL_MENTION = /\b[A-Za-z_]*ttl(?:_?seconds)?\b/i;

function isSkipped(name) {
  return SKIPPED_DIRS.has(name);
}

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isSkipped(entry.name) === false) {
        sourceFiles(path, found);
      }
      continue;
    }

    const isSource = SOURCE_EXTENSIONS.some((ext) => {
      return entry.name.endsWith(ext);
    });
    if (isSource) {
      found.push(path);
    }
  }

  return found;
}

function repoSourceFiles() {
  const roots = ['apps', 'packages', 'proprietary', 'scripts'].filter((name) => {
    const stats = statSync(join(repoRoot, name), { throwIfNoEntry: false });
    return stats !== undefined && stats.isDirectory();
  });

  const files = [];
  for (const root of roots) {
    files.push(...sourceFiles(join(repoRoot, root)));
  }

  return files.map((path) => {
    return relative(repoRoot, path).split(sep).join('/');
  });
}

/**
 * Matches a declaration with an optional type annotation and an optional
 * trailing comment, so annotating or commenting a mirror does not read as a
 * missing declaration.
 */
function declarationPattern(name, syntax) {
  if (syntax === 'py') {
    return new RegExp(`^${name}\\s*(?::[^=\\n]+)?=\\s*(\\d+)\\s*(?:#.*)?$`, 'm');
  }
  return new RegExp(`^export const ${name}\\s*(?::[^=\\n]+)?=\\s*(\\d+)\\s*;?\\s*(?://.*)?$`, 'm');
}

function syntaxOf(file) {
  return file.endsWith('.py') ? 'py' : 'ts';
}

function readDeclarations(file, source, problems) {
  const syntax = syntaxOf(file);
  const values = {};

  for (const name of NAMES) {
    const match = declarationPattern(name, syntax).exec(source);
    if (match === null) {
      continue;
    }
    values[name] = Number(match[1]);
  }

  if (Object.keys(values).length > 0 && Object.keys(values).length < NAMES.length) {
    const missing = NAMES.filter((name) => {
      return values[name] === undefined;
    });
    problems.push(`${file}: declares part of the pair, missing ${missing.join(', ')}`);
  }

  return values;
}

/**
 * A declaration line is where the literal is supposed to live, so it is not
 * itself a call site. Only an actual assignment counts: a clamp that keeps one
 * constant and replaces the other with a literal — `ttl >= TTL_SECONDS_MIN &&
 * ttl <= 86400` — mentions a name without declaring one, and is precisely the
 * half-drift the guard exists to catch.
 */
function isDeclarationLine(line) {
  return NAMES.some((name) => {
    return new RegExp(`^\\s*(?:export\\s+const\\s+)?${name}\\s*(?::[^=\\n]+)?=`).test(line);
  });
}

/**
 * A range written in prose describes a bound rather than applying one. Only the
 * line the match starts on is tested, so code carrying a trailing comment is
 * still a call site.
 */
function isCommentLine(line) {
  return /^(?:\/\/|\/\*|\*|#)/.test(line);
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function textAt(lines, line) {
  return lines[line - 1].trim();
}

function boundsIn(span, patterns) {
  const found = [];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const hit of span.matchAll(pattern)) {
      found.push({ value: hit[1], offset: hit.index });
    }
  }

  return found;
}

function schemaBoundsIn(file, source, report) {
  SCHEMA_FIELD.lastIndex = 0;

  for (const field of source.matchAll(SCHEMA_FIELD)) {
    if (TTL_FIELD_NAME.test(field[1]) === false) {
      continue;
    }
    const start = field.index + field[0].length;
    const rest = source.slice(start, start + SCHEMA_FIELD_SPAN);
    const sibling = NEXT_SCHEMA_FIELD.exec(rest);
    const span = sibling === null ? rest : rest.slice(0, sibling.index);

    const lower = boundsIn(span, LOWER_BOUNDS);
    const upper = boundsIn(span, UPPER_BOUNDS);
    if (lower.length === 0 || upper.length === 0) {
      continue;
    }

    for (const bound of [...lower, ...upper]) {
      if (/^\d+$/.test(bound.value) === false) {
        continue;
      }
      const line = lineAt(source, start + bound.offset);
      report(`${file}:${line}: the bound on ${field[1]} uses the literal ${bound.value}`);
    }
  }
}

function clampBoundsIn(file, source, lines, report) {
  for (const { pattern } of RANGE_BOUNDS) {
    pattern.lastIndex = 0;
    for (const hit of source.matchAll(pattern)) {
      const literal = hit[2] ?? hit[1];
      if (/^\d+$/.test(literal) === false) {
        continue;
      }

      // The range text counts as context: in `ttl >= 10 && ttl <= TTL_SECONDS_MAX`
      // the only mention of a TTL is inside the match, and looking at the
      // preceding lines alone would read it as an unrelated comparison.
      const before = source.slice(Math.max(0, hit.index - CLAMP_WINDOW), hit.index);
      if (TTL_MENTION.test(`${before}\n${hit[0]}`) === false) {
        continue;
      }

      const line = lineAt(source, hit.index);
      const text = textAt(lines, line);
      if (isDeclarationLine(text) || isCommentLine(text)) {
        continue;
      }

      report(`${file}:${line}: a TTL range check uses the literal ${literal} — ${text}`);
    }
  }
}

function literalBoundsIn(file, source) {
  const found = [];
  const seen = new Set();
  const lines = source.split('\n');

  const report = (problem) => {
    if (seen.has(problem) === false) {
      seen.add(problem);
      found.push(problem);
    }
  };

  schemaBoundsIn(file, source, report);
  clampBoundsIn(file, source, lines, report);

  return found;
}

function main() {
  const problems = [];
  const files = repoSourceFiles();

  let canonical = null;
  const mirrors = [];
  const literals = [];

  for (const file of files) {
    const source = readFileSync(join(repoRoot, file), 'utf8');

    if (
      NAMES.some((name) => {
        return source.includes(name);
      })
    ) {
      const values = readDeclarations(file, source, problems);
      if (Object.keys(values).length > 0) {
        if (file === CANONICAL_FILE) {
          canonical = values;
        } else {
          mirrors.push({ file, values });
        }
      }
    }

    if (TEST_PATH.test(file) === false) {
      literals.push(...literalBoundsIn(file, source));
    }
  }

  if (canonical === null) {
    problems.push(`${CANONICAL_FILE}: no canonical TTL_SECONDS_MIN/MAX declaration found`);
  } else {
    for (const { file, values } of mirrors) {
      for (const name of NAMES) {
        if (values[name] === undefined || values[name] === canonical[name]) {
          continue;
        }
        problems.push(
          `${name} has drifted:\n` +
            `    ${CANONICAL_FILE} declares ${canonical[name]}\n` +
            `    ${file} declares ${values[name]}`,
        );
      }
    }
  }

  for (const literal of literals) {
    problems.push(`${literal}\n    use TTL_SECONDS_MIN / TTL_SECONDS_MAX instead`);
  }

  if (problems.length > 0) {
    console.error('TTL constant guard failed:\n');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      `\nEvery declaration must match ${CANONICAL_FILE}, and every bound on a TTL` +
        ' must name a constant. Update all of them in the same commit.',
    );
    process.exit(1);
  }

  const summary = NAMES.map((name) => {
    return `${name}=${canonical[name]}`;
  }).join(' ');
  console.log(
    `TTL constant guard passed: ${summary} across ${mirrors.length + 1} declarations,` +
      ` no literal bounds in ${files.length} source files.`,
  );
}

main();
