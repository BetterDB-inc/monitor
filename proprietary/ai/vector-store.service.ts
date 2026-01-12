import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, Connection, Table } from '@lancedb/lancedb';
import { OllamaEmbeddings } from '@langchain/ollama';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface DocumentChunk extends Record<string, unknown> {
  id: string;
  text: string;
  vector: number[];
  source: string;
  title: string;
  project?: string;
}

export interface SearchResult {
  text: string;
  source: string;
  title: string;
  project: string;
  score: number;
}

@Injectable()
export class VectorStoreService implements OnModuleInit {
  private readonly logger = new Logger(VectorStoreService.name);
  private db: Connection | null = null;
  private table: Table | null = null;
  private embeddings: OllamaEmbeddings;
  private readonly dbPath: string;
  private readonly tableName = 'valkey_docs';

  constructor(private configService: ConfigService) {
    this.dbPath = this.configService.get<string>('ai.lancedbPath')!;
    const ollamaUrl = this.configService.get<string>('ai.ollamaUrl')!;

    this.embeddings = new OllamaEmbeddings({
      model: 'nomic-embed-text:v1.5',
      baseUrl: ollamaUrl,
    });
  }

  async onModuleInit(): Promise<void> {
    const aiEnabled = this.configService.get<boolean>('ai.enabled');
    if (!aiEnabled) {
      this.logger.log('AI features disabled, skipping vector store initialization');
      return;
    }

    try {
      // Connect to LanceDB
      this.logger.log(`Connecting to LanceDB at ${this.dbPath}`);
      this.db = await connect(this.dbPath);

      // Try to open existing table
      try {
        this.table = await this.db.openTable(this.tableName);
        const count = await this.table.countRows();
        this.logger.log(`Vector store initialized with ${count} documents`);
      } catch (error) {
        this.logger.log(`Table ${this.tableName} does not exist yet`);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize vector store: ${error.message}`);
      this.logger.warn('Document search will be unavailable');
    }
  }

  async indexDocs(docsDirectory: string): Promise<{ indexed: number; failed: number }> {
    if (!this.db) {
      throw new Error('Vector store not initialized');
    }

    this.logger.log(`Indexing documentation from ${docsDirectory}`);

    const files = await this.findMarkdownFiles(docsDirectory);
    this.logger.log(`Found ${files.length} markdown files`);

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const chunks: DocumentChunk[] = [];
    let indexed = 0;
    let failed = 0;

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(docsDirectory, filePath);
        const title = this.extractTitle(content) || path.basename(filePath, '.md');

        const splits = await textSplitter.splitText(content);

        for (let i = 0; i < splits.length; i++) {
          const text = splits[i];
          const vector = await this.embeddings.embedQuery(text);

          chunks.push({
            id: `${relativePath}:${i}`,
            text,
            vector,
            source: relativePath,
            title,
          });
        }

        indexed++;
        this.logger.log(`Indexed ${relativePath} (${splits.length} chunks)`);
      } catch (error) {
        failed++;
        this.logger.error(`Failed to index ${filePath}: ${error.message}`);
      }
    }

    // Create or overwrite table
    if (chunks.length > 0) {
      this.logger.log(`Creating table with ${chunks.length} chunks`);
      this.table = await this.db.createTable(this.tableName, chunks, {
        mode: 'overwrite',
      });
      this.logger.log(`Indexing complete: ${indexed} files, ${chunks.length} chunks`);
    }

    return { indexed, failed };
  }

  async search(query: string, limit = 5, preferProject?: 'valkey' | 'redis'): Promise<SearchResult[]> {
    if (!this.table) {
      this.logger.warn('Vector store not initialized, returning empty results');
      return [];
    }

    try {
      const embedStart = Date.now();
      const queryVector = await this.embeddings.embedQuery(query);
      this.logger.debug(`Embedding query took ${Date.now() - embedStart}ms`);

      const searchStart = Date.now();
      // Get more results than needed if we have a preference, so we can re-rank
      const fetchLimit = preferProject ? limit * 2 : limit;
      const results = await this.table.vectorSearch(queryVector).limit(fetchLimit).toArray();
      this.logger.debug(`Vector search took ${Date.now() - searchStart}ms (${results.length} results)`);

      // Map results
      let mappedResults = results.map((result: any) => ({
        text: result.text,
        source: result.source,
        title: result.title,
        project: result.project || this.inferProject(result.source),
        score: result._distance || 0,
      }));

      // Re-rank if we have a preference
      if (preferProject) {
        mappedResults = this.rankByProject(mappedResults, preferProject, limit);
      }

      return mappedResults.slice(0, limit);
    } catch (error) {
      this.logger.error(`Vector search failed: ${error.message}`);
      return [];
    }
  }

  private inferProject(source: string): string {
    // Infer project from file path
    if (source.toLowerCase().includes('valkey')) {
      return 'valkey';
    } else if (source.toLowerCase().includes('redis')) {
      return 'redis';
    }
    return 'unknown';
  }

  private rankByProject(results: SearchResult[], preferProject: string, limit: number): SearchResult[] {
    // Separate by project
    const preferred: SearchResult[] = [];
    const other: SearchResult[] = [];

    for (const result of results) {
      if (result.project === preferProject) {
        preferred.push(result);
      } else {
        other.push(result);
      }
    }

    // Return preferred first, then others
    return [...preferred, ...other];
  }

  private async findMarkdownFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.findMarkdownFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to read directory ${dir}: ${error.message}`);
    }

    return files;
  }

  private extractTitle(content: string): string | null {
    // Extract title from first # heading
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  isInitialized(): boolean {
    return this.table !== null;
  }

  async reload(): Promise<boolean> {
    this.logger.log('Reloading vector store...');
    try {
      await this.onModuleInit();
      return this.isInitialized();
    } catch (error) {
      this.logger.error(`Failed to reload vector store: ${error.message}`);
      return false;
    }
  }
}
