import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const BASE_URL = 'https://datasets-server.huggingface.co';
const PAGE_SIZE = 100;
const CONCURRENT_PAGES = 10;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', '.cache', 'datasets');

interface DatasetRow {
  [key: string]: unknown;
}

interface RowsResponse {
  rows: Array<{ row_idx: number; row: DatasetRow }>;
  num_rows_total: number;
}

/**
 * Load a HuggingFace dataset split.
 * Downloads from the API on first call, then caches locally as JSONL.
 * The full split is always cached; `limit` only trims the returned array.
 */
export async function fetchDataset(
  dataset: string,
  split: string,
  limit?: number,
  config = 'default',
): Promise<DatasetRow[]> {
  const cached = await readCache(dataset, config, split);
  if (cached) {
    console.log(`  [cache hit] ${dataset} / ${split} (${cached.length} rows)`);
    return limit ? cached.slice(0, limit) : cached;
  }

  console.log(`  [downloading] ${dataset} / ${split} ...`);
  const rows = await downloadDataset(dataset, config, split);
  await writeCache(dataset, config, split, rows);
  console.log(`  [cached] ${rows.length} rows → ${cachePath(dataset, config, split)}`);

  return limit ? rows.slice(0, limit) : rows;
}

// --- Remote fetching ---

async function downloadDataset(
  dataset: string,
  config: string,
  split: string,
): Promise<DatasetRow[]> {
  const firstPage = await fetchPage(dataset, config, split, 0, PAGE_SIZE);
  const totalAvailable = firstPage.num_rows_total;
  const rows: DatasetRow[] = firstPage.rows.map((r) => r.row);

  if (rows.length >= totalAvailable) {
    return rows;
  }

  const totalPages = Math.ceil(totalAvailable / PAGE_SIZE);
  for (let batch = 1; batch < totalPages; batch += CONCURRENT_PAGES) {
    const end = Math.min(batch + CONCURRENT_PAGES, totalPages);
    const promises: Promise<RowsResponse>[] = [];
    for (let page = batch; page < end; page++) {
      const offset = page * PAGE_SIZE;
      const length = Math.min(PAGE_SIZE, totalAvailable - offset);
      if (length <= 0) break;
      promises.push(fetchPage(dataset, config, split, offset, length));
    }
    const pages = await Promise.all(promises);
    for (const page of pages) {
      rows.push(...page.rows.map((r) => r.row));
    }
    process.stdout.write(`\r  [downloading] ${rows.length}/${totalAvailable} rows`);
  }
  process.stdout.write('\n');

  return rows;
}

async function fetchPage(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number,
  retries = 3,
): Promise<RowsResponse> {
  const params = new URLSearchParams({
    dataset,
    config,
    split,
    offset: String(offset),
    length: String(length),
  });
  const url = `${BASE_URL}/rows?${params}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      return (await res.json()) as RowsResponse;
    }
    if (res.status === 429 || res.status >= 500) {
      await delay(1000 * (attempt + 1));
      continue;
    }
    throw new Error(
      `HuggingFace API error ${res.status} for ${dataset} offset=${offset}: ${await res.text()}`,
    );
  }
  throw new Error(
    `HuggingFace API failed after ${retries} retries for ${dataset} offset=${offset}`,
  );
}

// --- Local cache (JSONL) ---

function cachePath(dataset: string, config: string, split: string): string {
  const safe = dataset.replace(/\//g, '--');
  return join(CACHE_DIR, `${safe}__${config}__${split}.jsonl`);
}

async function readCache(
  dataset: string,
  config: string,
  split: string,
): Promise<DatasetRow[] | null> {
  const path = cachePath(dataset, config, split);
  if (!existsSync(path)) return null;

  const content = await readFile(path, 'utf-8');
  const rows: DatasetRow[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    rows.push(JSON.parse(line) as DatasetRow);
  }
  return rows;
}

async function writeCache(
  dataset: string,
  config: string,
  split: string,
  rows: DatasetRow[],
): Promise<void> {
  const path = cachePath(dataset, config, split);
  await mkdir(dirname(path), { recursive: true });
  const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(path, content);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
