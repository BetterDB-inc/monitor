#!/usr/bin/env ts-node
/**
 * Script to download and index Valkey documentation for RAG
 *
 * Usage:
 *   pnpm ai:index-docs
 *
 * This script:
 * 1. Clones or updates the Valkey documentation repository
 * 2. Indexes all markdown files into the vector store
 * 3. Creates embeddings using Ollama
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

const VALKEY_DOCS_REPO = 'https://github.com/valkey-io/valkey-doc.git';
const DOCS_PATH = process.env.VALKEY_DOCS_PATH || './data/valkey-docs';
const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

async function main() {
  console.log('Starting Valkey documentation indexing...\n');

  console.log('[1/4] Checking Ollama availability...');
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      throw new Error('Ollama not responding');
    }
    console.log('Ollama is running\n');
  } catch (error) {
    console.error('Error: Ollama is not available at', OLLAMA_BASE_URL);
    console.error('Please start Ollama first: ollama serve');
    process.exit(1);
  }

  console.log('[2/4] Fetching Valkey documentation...');
  try {
    const docsExist = await fs.access(DOCS_PATH).then(() => true).catch(() => false);

    if (docsExist) {
      console.log('Updating existing repository...');
      await execAsync('git pull', { cwd: DOCS_PATH });
    } else {
      console.log('Cloning repository...');
      await fs.mkdir(path.dirname(DOCS_PATH), { recursive: true });
      await execAsync(`git clone ${VALKEY_DOCS_REPO} ${DOCS_PATH}`);
    }
    console.log('Documentation downloaded\n');
  } catch (error) {
    console.error('Error: Failed to fetch documentation:', error.message);
    process.exit(1);
  }

  console.log('[3/4] Scanning documentation files...');
  try {
    const { stdout } = await execAsync(`find ${DOCS_PATH} -name "*.md" -type f | wc -l`);
    const fileCount = parseInt(stdout.trim(), 10);
    console.log(`Found ${fileCount} markdown files\n`);
  } catch (error) {
    console.error('Error: Failed to scan files:', error.message);
  }

  console.log('[4/4] Indexing documentation into vector store...');
  console.log('This may take a few minutes...\n');

  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('@app/app.module');
    const { VectorStoreService } = await import('@proprietary/ai/vector-store.service');

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
    });

    const vectorStore = app.get(VectorStoreService);
    const result = await vectorStore.indexDocs(DOCS_PATH);

    await app.close();

    console.log('Indexing complete!');
    console.log(`Indexed: ${result.indexed} files`);
    if (result.failed > 0) {
      console.log(`Failed: ${result.failed} files`);
    }
    console.log(`Vector store: ${LANCEDB_PATH}\n`);
  } catch (error) {
    console.error('Error: Indexing failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }

  console.log('Done. AI assistant now has Valkey documentation context.\n');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
