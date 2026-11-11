import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright-core';
import type { SimConfig } from '../config.js';
import type { ScenarioEvent } from '../scenario/phase.js';
import { correlate } from './correlate.js';
import { renderSummary, timelineSvg, upsertFindingsSection, writeFindingsJsonl } from './summary.js';

const ROOT = new URL('../..', import.meta.url).pathname;

// `make report RUN=<id>`: everything except the PDF is a pure function of the run's files.
export async function report(cfg: SimConfig, runId: string) {
  const runDir = join(ROOT, 'runs', runId);
  const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ScenarioEvent);
  const c = correlate(runDir, cfg);
  writeFindingsJsonl(runDir, c);
  const runEnd = events.find((e) => e.phase === 'run' && e.action === 'end')?.ts ?? Math.max(...events.map((e) => e.ts));
  writeFileSync(join(runDir, 'timeline.svg'), timelineSvg(c, runEnd));
  const md = renderSummary(c, cfg, events, plan.meta);
  writeFileSync(join(runDir, 'SUMMARY.md'), md + '\n![timeline](timeline.svg)\n');
  writeFileSync(join(ROOT, 'SUMMARY.md'), md.replace(/\n$/, '') + `\n\n![timeline](runs/${runId}/timeline.svg)\n`);
  upsertFindingsSection(join(ROOT, 'FINDINGS.md'), c, md.split('\n').slice(2).join('\n'));

  // PDF (not byte-reproducible: Chromium stamps metadata). One A4 page by design.
  const html = `<!doctype html><meta charset="utf-8"><style>body{font:9.5px/1.35 sans-serif;margin:0}h1{font-size:14px;margin:0 0 4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:2px 4px;vertical-align:top}blockquote{margin:4px 0;color:#555}p,ul{margin:4px 0}svg{width:100%}</style>${await marked.parse(md)}${readFileSync(join(runDir, 'timeline.svg'), 'utf8')}`;
  const browser = await chromium.launch({ executablePath: cfg.report.chromiumPath });
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: join(runDir, 'SUMMARY.pdf'), format: 'A4', margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  await browser.close();
  console.log(md);
  console.log(`→ ${runDir}/{findings.jsonl,SUMMARY.md,SUMMARY.pdf,timeline.svg}, FINDINGS.md section ${c.runId}`);
}
