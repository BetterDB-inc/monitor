import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { collectTrial } from './collect';
import { assertPinned, pinStamp } from './product';
import { readTrace, traceFiles } from './trace';

export async function collectChunk(outFile: string, files: string[]): Promise<void> {
  const product = pinStamp(assertPinned());
  const lines: string[] = [];
  for (const file of files) {
    const startedAt = Date.now();
    const output = await collectTrial(readTrace(file), product);
    lines.push(JSON.stringify(output));
    console.log(`${output.trial} replayed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
  writeFileSync(outFile, lines.join('\n'));
}

export async function collectAll(runDir: string, outDir: string, jobs: number, only: string[] | null): Promise<string> {
  assertPinned();
  const files = traceFiles(runDir).filter((file) => !only || only.some((name) => file.includes(`/${name}/`)));
  if (files.length === 0) throw new Error(`no recordings under ${runDir}`);
  mkdirSync(outDir, { recursive: true });
  const workers = Math.max(1, Math.min(jobs, files.length));
  const parts = Array.from({ length: workers }, (_, index) => join(outDir, `part-${index}.jsonl`));
  await Promise.all(
    parts.map(
      (part, index) =>
        new Promise<void>((resolve, reject) => {
          const chunk = files.filter((_, position) => position % workers === index);
          const child = spawn(
            process.execPath,
            [...process.execArgv, process.argv[1], 'collect-chunk', part, ...chunk],
            { stdio: 'inherit' },
          );
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`replay worker ${index} exited with ${code}`))));
        }),
    ),
  );
  const lines = parts
    .flatMap((part) => readFileSync(part, 'utf8').split('\n').filter(Boolean))
    .sort((a, b) => {
      const left = (JSON.parse(a) as { trial: string }).trial;
      const right = (JSON.parse(b) as { trial: string }).trial;
      return left < right ? -1 : 1;
    });
  const outFile = join(outDir, 'trials.jsonl.gz');
  writeFileSync(outFile, gzipSync(lines.join('\n'), { level: 9 }));
  for (const part of parts) rmSync(part);
  return outFile;
}
