import { readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * RedisShake jobs write `<jobId>.toml` (source and target credentials) and
 * `<jobId>.pid` into the OS temp dir and delete both when the run ends. A crash,
 * an OOM kill or a SIGKILL skips that cleanup, so the files are swept on the
 * next start.
 */
const JOB_TOML = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.toml$/;

/**
 * A TOML with no PID file is either a run that died before spawning RedisShake,
 * or a run of another BetterDB process sharing this temp dir that is still in
 * its pre-spawn work (function probe, target flush). Only the first lasts.
 */
export const ORPHAN_TOML_MIN_AGE_MS = 10 * 60_000;

export interface StaleJobFileSweep {
  /** TOML paths removed (with their PID files). */
  removed: string[];
  /** TOML paths left in place because their RedisShake process is still alive. */
  kept: Array<{ tomlPath: string; pid: number }>;
}

export interface SweepOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
}

export function sweepStaleJobFiles(dir: string, options: SweepOptions = {}): StaleJobFileSweep {
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? isProcessAlive;
  const result: StaleJobFileSweep = { removed: [], kept: [] };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const name of entries) {
    const match = JOB_TOML.exec(name);
    if (!match) continue;
    const tomlPath = join(dir, name);
    const pidPath = join(dir, `${match[1]}.pid`);
    try {
      // Only touch files this service wrote: a RedisShake config with a reader
      // and a writer section.
      if (!isRedisShakeConfig(tomlPath)) continue;

      const pid = readPid(pidPath);
      if (pid === null) {
        if (now - statSync(tomlPath).mtimeMs < ORPHAN_TOML_MIN_AGE_MS) continue;
      } else if (isAlive(pid)) {
        // Never kill here: the PID may belong to another live BetterDB process
        // or have been reused. Leave the files and let the caller report it.
        result.kept.push({ tomlPath, pid });
        continue;
      }

      unlinkIfPresent(tomlPath);
      unlinkIfPresent(pidPath);
      result.removed.push(tomlPath);
    } catch {
      // One unreadable file must not stop the sweep.
    }
  }
  return result;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRedisShakeConfig(path: string): boolean {
  const content = readFileSync(path, 'utf8');
  return (
    content.includes('[redis_writer]') &&
    (content.includes('[scan_reader]') || content.includes('[sync_reader]'))
  );
}

function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
