import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Guards the release-time telemetry injection, which is what stands between a
 * missed key and another telemetry-blind publish (the 0.4.0-0.8.0 incident).
 *
 * The script resolves its target as `__dirname/../dist/analytics.js`, so it is
 * copied into a temp package layout with its own dist/ rather than run in place
 * — same bytes, but the real build output is never touched. The identical
 * script ships in agent-memory, retrieval and semantic-cache; asserting the
 * copies stay in sync keeps this one test honest for all four.
 */

const SCRIPT = resolve(__dirname, '../../scripts/inject-telemetry-defaults.mjs');
const SIBLINGS = ['agent-memory', 'retrieval', 'semantic-cache'];
const API_KEY_PLACEHOLDER = '__BETTERDB_POSTHOG_API_KEY__';
const HOST_PLACEHOLDER = '__BETTERDB_POSTHOG_HOST__';

let workdir: string;

function runInject(env: Record<string, string | undefined>): {
  status: number | null;
  stderr: string;
  stdout: string;
  output: string;
} {
  const scriptCopy = join(workdir, 'scripts', 'inject-telemetry-defaults.mjs');
  const target = join(workdir, 'dist', 'analytics.js');
  const result = spawnSync(process.execPath, [scriptCopy], {
    encoding: 'utf8',
    // Strip inherited values so CI, which sets these for real releases, cannot
    // leak a key in and mask a failure this test is meant to catch.
    env: {
      ...process.env,
      POSTHOG_API_KEY: undefined,
      POSTHOG_HOST: undefined,
      REQUIRE_TELEMETRY_KEY: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    output: readFileSync(target, 'utf8'),
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'inject-telemetry-'));
  mkdirSync(join(workdir, 'scripts'));
  mkdirSync(join(workdir, 'dist'));
  copyFileSync(SCRIPT, join(workdir, 'scripts', 'inject-telemetry-defaults.mjs'));
  writeFileSync(
    join(workdir, 'dist', 'analytics.js'),
    `const apiKey = '${API_KEY_PLACEHOLDER}';\nconst host = '${HOST_PLACEHOLDER}';\n`,
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('inject-telemetry-defaults', () => {
  it('fails the build when the key is required but not supplied', () => {
    const result = runInject({ REQUIRE_TELEMETRY_KEY: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to ship a telemetry-blind build');
    expect(result.output).toContain(API_KEY_PLACEHOLDER);
  });

  it('fails the build when the placeholder is absent, rather than reporting success', () => {
    // A key is supplied but the token was renamed in src, so nothing is
    // substituted. Absence of the placeholder must not read as "injected".
    writeFileSync(join(workdir, 'dist', 'analytics.js'), `const apiKey = '__RENAMED_TOKEN__';\n`);

    const result = runInject({ REQUIRE_TELEMETRY_KEY: '1', POSTHOG_API_KEY: 'phc_real_key' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('was not found in the build output');
    expect(result.output).not.toContain('phc_real_key');
  });

  it('injects the key and host, and passes the guard, when both are supplied', () => {
    const result = runInject({
      REQUIRE_TELEMETRY_KEY: '1',
      POSTHOG_API_KEY: 'phc_real_key',
      POSTHOG_HOST: 'https://eu.posthog.com',
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('phc_real_key');
    expect(result.output).toContain('https://eu.posthog.com');
    expect(result.output).not.toContain(API_KEY_PLACEHOLDER);
    expect(result.output).not.toContain(HOST_PLACEHOLDER);
  });

  it('leaves placeholders intact for a local build that does not require a key', () => {
    const result = runInject({});

    expect(result.status).toBe(0);
    expect(result.output).toContain(API_KEY_PLACEHOLDER);
    expect(result.stdout).toContain('noop fallback');
  });

  it('stays byte-identical to the sibling packages it stands in for', () => {
    const canonical = readFileSync(SCRIPT, 'utf8');

    for (const sibling of SIBLINGS) {
      const siblingScript = resolve(
        __dirname,
        `../../../${sibling}/scripts/inject-telemetry-defaults.mjs`,
      );
      expect(readFileSync(siblingScript, 'utf8'), `${sibling} inject script drifted`).toBe(
        canonical,
      );
    }
  });
});
