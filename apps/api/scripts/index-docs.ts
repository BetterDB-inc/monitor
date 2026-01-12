#!/usr/bin/env npx ts-node

/**
 * Documentation Indexing Script
 *
 * Downloads, processes, and embeds Valkey/Redis documentation
 * for use by the BetterDB chatbot.
 *
 * Usage:
 *   pnpm docs:index           # Index both Valkey and Redis
 *   pnpm docs:index:valkey    # Index Valkey only
 *   pnpm docs:index:redis     # Index Redis only
 *   pnpm docs:download        # Download docs without indexing
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Check if running with embedding (requires Ollama)
const EMBED = process.env.EMBED !== 'false';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SOURCE = process.env.SOURCE || 'both'; // 'valkey' | 'redis' | 'both'

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');

interface DocChunk {
  id: string;
  text: string;
  title: string;
  source: string;
  project: 'valkey' | 'redis';
  category: 'command' | 'concept' | 'config';
}

async function downloadDocs(project: 'valkey' | 'redis'): Promise<string> {
  const repoUrl = project === 'valkey'
    ? 'https://github.com/valkey-io/valkey-doc.git'
    : 'https://github.com/redis/redis-doc.git';

  const targetDir = path.join(DOCS_DIR, `${project}-doc`);

  console.log(`Downloading ${project} documentation...`);

  if (fs.existsSync(targetDir)) {
    // Update existing
    console.log(`   Updating existing clone...`);
    execSync(`git -C "${targetDir}" pull --ff-only`, { stdio: 'inherit' });
  } else {
    // Fresh clone (shallow for speed)
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    execSync(`git clone --depth 1 "${repoUrl}" "${targetDir}"`, { stdio: 'inherit' });
  }

  console.log(`Done: ${project} docs ready at ${targetDir}`);
  return targetDir;
}

function processCommandFile(filePath: string, project: 'valkey' | 'redis'): DocChunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.md');
  const commandName = fileName.toUpperCase().replace(/-/g, ' ');

  const chunks: DocChunk[] = [];
  const baseUrl = project === 'valkey' ? 'https://valkey.io' : 'https://redis.io';

  // Extract frontmatter/metadata if present
  let mainContent = content;
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatterMatch) {
    mainContent = frontmatterMatch[2];
  }

  // Create one chunk for the whole command (most commands are reasonably sized)
  // Truncate if too long
  const maxLength = 1500;
  let text = `Command: ${commandName}\n\n${mainContent}`;

  if (text.length > maxLength) {
    // Take description/syntax sections only
    const sections = mainContent.split(/^## /gm);
    text = `Command: ${commandName}\n\n${sections.slice(0, 3).join('\n## ')}`;
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '...';
    }
  }

  chunks.push({
    id: `${project}-cmd-${fileName}`,
    text,
    title: commandName,
    source: `${baseUrl}/commands/${fileName.toLowerCase()}/`,
    project,
    category: 'command',
  });

  return chunks;
}

function processConceptFile(filePath: string, project: 'valkey' | 'redis', category: string): DocChunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.md');
  const title = fileName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const chunks: DocChunk[] = [];
  const baseUrl = project === 'valkey' ? 'https://valkey.io' : 'https://redis.io';

  // Split by ## headers
  const sections = content.split(/^## /gm);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (section.length < 100) continue;

    const lines = section.split('\n');
    const sectionTitle = i === 0 ? 'Overview' : lines[0]?.trim() || `Section ${i}`;
    const sectionContent = i === 0 ? section : lines.slice(1).join('\n').trim();

    // Skip empty or very short sections
    if (sectionContent.length < 50) continue;

    // Truncate long sections
    const maxLength = 1200;
    let text = `${title}: ${sectionTitle}\n\n${sectionContent}`;
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '...';
    }

    chunks.push({
      id: `${project}-${category}-${fileName}-${i}`,
      text,
      title: `${title} - ${sectionTitle}`,
      source: `${baseUrl}/docs/${category}/`,
      project,
      category: 'concept',
    });
  }

  return chunks;
}

function processDocs(docsDir: string, project: 'valkey' | 'redis'): DocChunk[] {
  const chunks: DocChunk[] = [];

  // Process commands
  const commandsDir = path.join(docsDir, 'commands');
  if (fs.existsSync(commandsDir)) {
    console.log(`   Processing ${project} commands...`);
    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        chunks.push(...processCommandFile(path.join(commandsDir, file), project));
      } catch (e) {
        console.warn(`   Warning: Failed to process ${file}: ${e.message}`);
      }
    }
    console.log(`   Processed ${files.length} command files`);
  }

  // Process topics/concepts
  const topicsDir = path.join(docsDir, 'topics');
  if (fs.existsSync(topicsDir)) {
    console.log(`   Processing ${project} topics...`);
    const files = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        chunks.push(...processConceptFile(path.join(topicsDir, file), project, 'topics'));
      } catch (e) {
        console.warn(`   Warning: Failed to process ${file}: ${e.message}`);
      }
    }
    console.log(`   Processed ${files.length} topic files`);
  }

  return chunks;
}

async function embedChunks(chunks: DocChunk[]): Promise<void> {
  console.log(`Embedding ${chunks.length} chunks...`);
  console.log(`Using Ollama at ${OLLAMA_URL}`);

  // Dynamic import to avoid requiring these deps if not embedding
  const lancedb = await import('@lancedb/lancedb');
  const { OllamaEmbeddings } = await import('@langchain/ollama');

  const embeddings = new OllamaEmbeddings({
    model: 'nomic-embed-text:v1.5',
    baseUrl: OLLAMA_URL,
  });

  // Test connection
  try {
    console.log('Testing Ollama connection...');
    await embeddings.embedQuery('test');
    console.log('Ollama connected');
  } catch (e) {
    console.error('Error: Cannot connect to Ollama. Is it running?');
    console.error('Run: ollama serve');
    console.error('Then: ollama pull nomic-embed-text:v1.5');
    process.exit(1);
  }

  // Connect to LanceDB (same path as VectorStoreService)
  const LANCEDB_PATH = path.join(DATA_DIR, 'lancedb');
  fs.mkdirSync(LANCEDB_PATH, { recursive: true });

  console.log(`   Connecting to LanceDB at ${LANCEDB_PATH}`);
  const db = await lancedb.connect(LANCEDB_PATH);

  // Embed in batches with progress
  const batchSize = 20;
  const totalBatches = Math.ceil(chunks.length / batchSize);
  const records: Array<{
    id: string;
    text: string;
    title: string;
    source: string;
    project: string;
    category: string;
    vector: number[];
  }> = [];

  console.log(`   Embedding in batches of ${batchSize}...`);

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batch = chunks.slice(i, i + batchSize);
    const startTime = Date.now();

    // Embed batch
    const vectors = await embeddings.embedDocuments(batch.map(c => c.text));

    // Add to records
    for (let j = 0; j < batch.length; j++) {
      records.push({
        id: batch[j].id,
        text: batch[j].text,
        title: batch[j].title,
        source: batch[j].source,
        project: batch[j].project,
        category: batch[j].category,
        vector: vectors[j],
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const progress = ((batchNum / totalBatches) * 100).toFixed(0);
    console.log(`   [${progress}%] Batch ${batchNum}/${totalBatches} (${batch.length} docs) - ${elapsed}s`);
  }

  // Drop existing table if exists, create new one
  const TABLE_NAME = 'valkey_docs';

  try {
    await db.dropTable(TABLE_NAME);
    console.log(`   Dropped existing ${TABLE_NAME} table`);
  } catch {
    // Table didn't exist, that's fine
  }

  await db.createTable(TABLE_NAME, records);
  console.log(`Created ${TABLE_NAME} table with ${records.length} documents`);
}

async function main() {
  console.log('BetterDB Documentation Indexer\n');

  const chunks: DocChunk[] = [];

  // Download and process
  if (SOURCE === 'valkey' || SOURCE === 'both') {
    const valkeyDir = await downloadDocs('valkey');
    chunks.push(...processDocs(valkeyDir, 'valkey'));
  }

  if (SOURCE === 'redis' || SOURCE === 'both') {
    const redisDir = await downloadDocs('redis');
    chunks.push(...processDocs(redisDir, 'redis'));
  }

  console.log(`\nTotal chunks: ${chunks.length}`);

  // Save chunks JSON (useful for debugging/inspection)
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const chunksFile = path.join(CHUNKS_DIR, `${SOURCE === 'both' ? 'all' : SOURCE}.json`);
  fs.writeFileSync(chunksFile, JSON.stringify(chunks, null, 2));
  console.log(`Chunks saved to ${chunksFile}`);

  // Embed if requested
  if (EMBED) {
    await embedChunks(chunks);
  } else {
    console.log(`\nSkipping embedding (EMBED=false)`);
    console.log(`   Run with EMBED=true to create vector store`);
  }

  console.log('\nDone!');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
