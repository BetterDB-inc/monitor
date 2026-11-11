import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { SimConfig } from '../config.js';
import { valkeyPods } from '../infra/verify.js';
import { BetterdbApi } from './api.js';

// Taken live at each phase end: the target node's connection only exists while its pod
// keeps its IP (a roll/reset retires it, and the UI then falls back to the seed).
// Routes verified in v0.55.0 apps/web: /anomalies takes ?connection=&start=&end= (ms).
export class Screenshots {
  private browser?: Browser;
  constructor(private readonly cfg: SimConfig, private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private async shoot(page: Page, path: string, heading: string, file: string) {
    const c = this.cfg.screenshots;
    await page.goto(new URL(path, this.cfg.betterdb.url).toString(), { waitUntil: 'networkidle', timeout: c.timeoutMs }).catch(() => undefined);
    const h = page.getByRole('heading', { name: heading }).first();
    await h.waitFor({ timeout: c.timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(c.settleMs);
    await h.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: file });
    return file;
  }

  async capture(phase: string, targetPods: string[], start: number) {
    const c = this.cfg.screenshots;
    this.browser ??= await chromium.launch({ executablePath: this.cfg.report.chromiumPath });
    const page = await this.browser.newPage({ viewport: { width: c.width, height: c.height } });
    const conns = (await new BetterdbApi(this.cfg).connections()).connections.filter((x) => !x.membership?.retiredAt);
    const ipByPod = new Map((await valkeyPods(this.cfg)).map((p) => [p.name, p.ip]));
    const node = targetPods.map((p) => conns.find((x) => x.host === ipByPod.get(p))).find(Boolean);
    const q = new URLSearchParams({ start: String(start - this.cfg.prospect.windowPadSec * 1000), end: String(Date.now()) });
    if (node) q.set('connection', node.id);
    const out = [
      await this.shoot(page, `/anomalies?${q}`, 'Anomaly Detection', join(this.dir, `${phase}-anomalies.png`)),
      await this.shoot(page, '/cluster', 'Cluster Overview', join(this.dir, `${phase}-cluster.png`)),
    ];
    const panel = c.panels[phase];
    if (panel) out.push(await this.panel(page, panel, panel.view === 'node' ? `/anomalies?${q}` : '/cluster', join(this.dir, `${phase}-panel.png`)));
    await page.close();
    return out;
  }

  // Crop to the one panel that proves the phase's claim: the element whose text is `anchor`,
  // widened to its nearest ancestor carrying class `container` (or clipped to `clip`).
  private async panel(page: Page, p: SimConfig['screenshots']['panels'][string], path: string, file: string) {
    const c = this.cfg.screenshots;
    await page.goto(new URL(path, this.cfg.betterdb.url).toString(), { waitUntil: 'networkidle', timeout: c.timeoutMs }).catch(() => undefined);
    if (p.tab) await page.getByRole('tab', { name: p.tab }).click({ timeout: c.timeoutMs }).catch(() => page.getByText(p.tab!, { exact: true }).first().click());
    const anchor = page.getByText(p.anchor, { exact: true }).first();
    await anchor.waitFor({ timeout: c.timeoutMs });
    await page.waitForTimeout(c.settleMs);
    if (p.clip) {
      await page.screenshot({ path: file, clip: { x: p.clip[0], y: p.clip[1], width: p.clip[2], height: p.clip[3] } });
    } else {
      const box = anchor.locator(`xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ${p.container} ')][1]`);
      await box.screenshot({ path: file });
    }
    return file;
  }

  async close() {
    await this.browser?.close();
  }
}
