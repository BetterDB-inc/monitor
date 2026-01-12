import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';

@Injectable()
export class OllamaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OllamaService.name);
  private ollama: Ollama;
  private readonly baseUrl: string;
  private readonly keepAlive: string;
  private readonly requiredModels = ['qwen2.5:7b', 'nomic-embed-text:v1.5'];
  private warmupInterval: NodeJS.Timeout | null = null;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('ai.ollamaUrl')!;
    this.keepAlive = this.configService.get<string>('ai.ollamaKeepAlive', '24h');
    this.ollama = new Ollama({ host: this.baseUrl });
  }

  async onModuleInit(): Promise<void> {
    const aiEnabled = this.configService.get<boolean>('ai.enabled');
    if (!aiEnabled) {
      this.logger.log('AI features disabled via config');
      return;
    }

    this.logger.log(`Connecting to Ollama at ${this.baseUrl}`);

    // Check if Ollama is available
    try {
      await this.checkOllamaHealth();
    } catch (error) {
      this.logger.error(`Failed to connect to Ollama: ${error.message}`);
      this.logger.warn('AI features will be unavailable');
      return;
    }

    // Check and pull required models
    for (const model of this.requiredModels) {
      await this.ensureModel(model);
    }

    this.logger.log('Ollama service initialized successfully');

    // Warm up models to keep them loaded
    await this.warmupModels();

    // Re-warm models every 20 minutes to prevent unloading
    this.warmupInterval = setInterval(() => {
      this.warmupModels().catch((err) => this.logger.warn(`Model warmup failed: ${err.message}`));
    }, 20 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.warmupInterval) {
      clearInterval(this.warmupInterval);
      this.warmupInterval = null;
    }
  }

  private async checkOllamaHealth(): Promise<void> {
    try {
      await this.ollama.list();
    } catch (error) {
      throw new Error(`Ollama not responding at ${this.baseUrl}: ${error.message}`);
    }
  }

  private async ensureModel(modelName: string): Promise<void> {
    try {
      // Check if model exists
      await this.ollama.show({ model: modelName });
      this.logger.log(`Model ${modelName} is available`);
    } catch (error) {
      // Model doesn't exist, pull it
      this.logger.log(`Model ${modelName} not found, pulling...`);
      try {
        const stream = await this.ollama.pull({
          model: modelName,
          stream: true,
        });

        let lastProgress = 0;
        for await (const part of stream) {
          if (part.status === 'downloading') {
            const progress = Math.round(((part.completed || 0) / (part.total || 1)) * 100);
            if (progress > lastProgress && progress % 10 === 0) {
              this.logger.log(`Pulling ${modelName}: ${progress}%`);
              lastProgress = progress;
            }
          }
        }

        this.logger.log(`Model ${modelName} pulled successfully`);
      } catch (pullError) {
        this.logger.error(`Failed to pull model ${modelName}: ${pullError.message}`);
        throw pullError;
      }
    }
  }

  getOllama(): Ollama {
    return this.ollama;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ollama.list();
      return true;
    } catch {
      return false;
    }
  }

  async warmupModels(): Promise<void> {
    this.logger.log('Warming up models...');
    const startTime = Date.now();

    // Warm up LLM (qwen2.5:7b)
    try {
      const llmStart = Date.now();
      await this.ollama.generate({
        model: 'qwen2.5:7b',
        prompt: 'Hi',
        options: {
          num_predict: 1, // Generate just 1 token
        },
        keep_alive: this.keepAlive,
      });
      this.logger.log(`LLM warmed up in ${Date.now() - llmStart}ms (keep_alive: ${this.keepAlive})`);
    } catch (error) {
      this.logger.error(`Failed to warm up LLM: ${error.message}`);
    }

    // Warm up embedding model (nomic-embed-text:v1.5)
    try {
      const embStart = Date.now();
      await this.ollama.embeddings({
        model: 'nomic-embed-text:v1.5',
        prompt: 'test',
        keep_alive: this.keepAlive,
      });
      this.logger.log(`Embedding model warmed up in ${Date.now() - embStart}ms`);
    } catch (error) {
      this.logger.error(`Failed to warm up embedding model: ${error.message}`);
    }

    this.logger.log(`Model warmup complete in ${Date.now() - startTime}ms`);
  }

  getKeepAlive(): string {
    return this.keepAlive;
  }
}
