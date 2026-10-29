import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ORPHAN_TOML_MIN_AGE_MS,
  isProcessAlive,
  sweepStaleJobFiles,
} from '../execution/stale-job-files';

const JOB_A = '3f2b8c1e-6a4d-4e7f-9b2a-1c3d5e7f9a0b';
const JOB_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SCAN_TOML =
  '[scan_reader]\naddress = "10.0.0.1:6379"\npassword = "secret"\n\n[redis_writer]\n';
const SYNC_TOML = '[sync_reader]\naddress = "10.0.0.1:6379"\n\n[redis_writer]\n';

describe('sweepStaleJobFiles', () => {
  let dir: string;
  const now = Date.now();
  const dead = () => false;
  const alive = () => true;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'betterdb-sweep-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string, ageMs = 0): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    if (ageMs > 0) {
      const at = (now - ageMs) / 1000;
      utimesSync(path, at, at);
    }
    return path;
  }

  it('removes the config and PID file of a job whose RedisShake process is gone', () => {
    const toml = write(`${JOB_A}.toml`, SCAN_TOML);
    const pid = write(`${JOB_A}.pid`, '12345');

    const result = sweepStaleJobFiles(dir, { now, isAlive: dead });

    expect(result).toEqual({ removed: [toml], kept: [] });
    expect(existsSync(toml)).toBe(false);
    expect(existsSync(pid)).toBe(false);
  });

  it('keeps the files of a job whose RedisShake process is still alive, and never signals it', () => {
    const toml = write(`${JOB_A}.toml`, SYNC_TOML);
    write(`${JOB_A}.pid`, '12345');
    const isAlive = jest.fn(alive);

    const result = sweepStaleJobFiles(dir, { now, isAlive });

    expect(result).toEqual({ removed: [], kept: [{ tomlPath: toml, pid: 12345 }] });
    expect(isAlive).toHaveBeenCalledWith(12345);
    expect(existsSync(toml)).toBe(true);
  });

  it('removes a config with no PID file once it is older than the pre-spawn window', () => {
    const old = write(`${JOB_A}.toml`, SCAN_TOML, ORPHAN_TOML_MIN_AGE_MS + 1_000);
    const fresh = write(`${JOB_B}.toml`, SCAN_TOML);

    const result = sweepStaleJobFiles(dir, { now, isAlive: dead });

    expect(result.removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('treats an unreadable PID file like a missing one', () => {
    const toml = write(`${JOB_A}.toml`, SCAN_TOML, ORPHAN_TOML_MIN_AGE_MS + 1_000);
    write(`${JOB_A}.pid`, 'not-a-pid');

    expect(sweepStaleJobFiles(dir, { now, isAlive: alive }).removed).toEqual([toml]);
  });

  it('ignores files it did not write', () => {
    const otherApp = write(
      `${JOB_A}.toml`,
      '[package]\nname = "x"\n',
      ORPHAN_TOML_MIN_AGE_MS + 1_000,
    );
    const notAJob = write('settings.toml', SCAN_TOML, ORPHAN_TOML_MIN_AGE_MS + 1_000);

    expect(sweepStaleJobFiles(dir, { now, isAlive: dead })).toEqual({ removed: [], kept: [] });
    expect(existsSync(otherApp)).toBe(true);
    expect(existsSync(notAJob)).toBe(true);
  });

  it('returns an empty result for a directory it cannot read', () => {
    expect(sweepStaleJobFiles(join(dir, 'missing'))).toEqual({ removed: [], kept: [] });
  });
});

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a PID with no process as gone', () => {
    // PIDs are capped well below 2^22 on Linux and 99999 on macOS.
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});
