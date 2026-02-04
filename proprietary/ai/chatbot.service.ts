import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { VectorStoreService } from './vector-store.service';
import { OllamaService } from './ollama.service';
import { createMonitoringTools } from './tools/monitoring-tools';

import { MetricsService } from '@app/metrics/metrics.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { ClientAnalyticsService } from '@app/client-analytics/client-analytics.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { ChatMessage } from '@betterdb/shared';

@Injectable()
export class ChatbotService implements OnModuleInit {
  private readonly logger = new Logger(ChatbotService.name);
  private llm: ChatOllama;
  private llmWithTools: ReturnType<ChatOllama['bindTools']>;
  private tools: ReturnType<typeof createMonitoringTools>;
  private toolMap: Map<string, (args: Record<string, unknown>) => Promise<string>>;

  constructor(
    private configService: ConfigService,
    private vectorStore: VectorStoreService,
    private ollamaService: OllamaService,
    private metricsService: MetricsService,
    private connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storageClient: StoragePort,
    private clientAnalyticsService: ClientAnalyticsService,
  ) {
    const ollamaUrl = this.configService.get<string>('ai.ollamaUrl')!;
    const keepAlive = this.configService.get<string>('ai.ollamaKeepAlive', '24h');

    this.llm = new ChatOllama({
      model: 'qwen2.5:7b',
      baseUrl: ollamaUrl,
      temperature: 0.3,
      keepAlive: keepAlive,
    });

    // Create monitoring tools
    this.tools = createMonitoringTools({
      metricsService,
      storageClient,
      clientAnalyticsService,
      connectionRegistry,
    });

    // Bind tools to LLM
    this.llmWithTools = this.llm.bindTools(this.tools);

    // Create tool lookup map for execution
    this.toolMap = new Map();
    for (const t of this.tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolFn = t as any;
      this.toolMap.set(t.name, async (args: Record<string, unknown>) => {
        const result = await toolFn.invoke(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      });
    }
  }

  async onModuleInit() {
    this.logger.log(`Chatbot initialized with ${this.tools.length} tools`);
  }

  private buildSystemPrompt(connectionId?: string): string {
    // connectionRegistry.get() throws if connection not found - let it propagate
    const connection = this.connectionRegistry.get(connectionId);
    const capabilities = connection.getCapabilities();
    const dbName = capabilities.dbType === 'valkey' ? 'Valkey' : 'Redis';

    return `You are BetterDB Assistant, a helpful AI for monitoring ${dbName} databases.

IMPORTANT RULES:
1. Use the available tools to get real-time data. DO NOT make up metrics.
2. When asked about clients, memory, keys, slowlog, etc. - ALWAYS call the appropriate tool first.
3. After getting tool results, summarize them clearly for the user.
4. If documentation context is provided, use it to answer conceptual questions.
5. Use "${dbName}" consistently (not "Redis/Valkey" or "Valkey (Redis fork)").

Available tools:
- get_server_status: Overall server health (clients, memory, ops/sec, keys, uptime)
- get_connected_clients: Number of connected/blocked clients
- get_memory_usage: Memory statistics
- get_key_count: Total keys in database
- get_slowlog: Recent slow commands
- get_slowlog_patterns: Analyze slow command patterns
- get_client_list: Connected clients grouped by name
- get_acl_failures: Authentication/authorization failures
- get_client_analytics: Connection trends over time
- run_latency_diagnosis: Latency diagnostic report
- run_memory_diagnosis: Memory diagnostic report

When users ask operational questions, call the relevant tool(s) to get fresh data.`;
  }

  async chat(message: string, history?: ChatMessage[], connectionId?: string): Promise<string> {
    const startTime = Date.now();

    const aiEnabled = this.configService.get<boolean>('ai.enabled');
    if (!aiEnabled) {
      return 'AI features are disabled. Set AI_ENABLED=true to enable.';
    }

    const isAvailable = await this.ollamaService.isAvailable();
    if (!isAvailable) {
      return 'AI assistant unavailable. Ensure Ollama is running.';
    }

    // Handle help command
    if (this.isHelpCommand(message)) {
      return this.getHelpMessage(connectionId);
    }

    try {
      // Build messages array with connection-specific system prompt
      const systemPrompt = this.buildSystemPrompt(connectionId);
      const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

      // Add conversation history
      if (history?.length) {
        for (const msg of history.slice(-6)) {
          messages.push(msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content));
        }
      }

      // Check if we should add documentation context
      const docContext = await this.getDocumentationContext(message, connectionId);
      const userMessage = docContext
        ? `${message}\n\n<documentation>\n${docContext}\n</documentation>`
        : message;

      messages.push(new HumanMessage(userMessage));

      // Call LLM with tools - iterate until no more tool calls
      let response = await this.llmWithTools.invoke(messages);
      let iterations = 0;
      const maxIterations = 5;

      while (response.tool_calls?.length && iterations < maxIterations) {
        iterations++;
        this.logger.log(`Tool calls (iteration ${iterations}): ${response.tool_calls.map((tc) => tc.name).join(', ')}`);

        // Execute tool calls with connectionId injected
        const toolResults: ToolMessage[] = [];
        for (const toolCall of response.tool_calls) {
          const toolFn = this.toolMap.get(toolCall.name);
          if (toolFn) {
            try {
              // Inject connectionId into tool args for proper multi-database scoping
              const argsWithConnection = { ...toolCall.args, connectionId };
              const result = await toolFn(argsWithConnection);
              this.logger.debug(`Tool ${toolCall.name} result: ${result.substring(0, 200)}...`);
              toolResults.push(new ToolMessage({ content: result, tool_call_id: toolCall.id! }));
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : 'Unknown error';
              this.logger.error(`Tool ${toolCall.name} failed: ${errMsg}`);
              toolResults.push(new ToolMessage({ content: `Error: ${errMsg}`, tool_call_id: toolCall.id! }));
            }
          } else {
            toolResults.push(new ToolMessage({ content: `Unknown tool: ${toolCall.name}`, tool_call_id: toolCall.id! }));
          }
        }

        // Continue conversation with tool results
        messages.push(response);
        messages.push(...toolResults);
        response = await this.llmWithTools.invoke(messages);
      }

      const responseText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const duration = Date.now() - startTime;
      this.logger.log(`Chat completed in ${duration}ms (${iterations} tool iterations)`);

      return responseText;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Chat error: ${errMsg}`);
      return `Error: ${errMsg}`;
    }
  }

  private async getDocumentationContext(message: string, connectionId?: string): Promise<string | null> {
    if (!this.vectorStore.isInitialized()) {
      return null;
    }

    // Only search docs for conceptual questions
    const conceptualKeywords = ['what is', 'what are', 'how to', 'how do', 'explain', 'difference between', 'when to use'];
    const isConceptual = conceptualKeywords.some((kw) => message.toLowerCase().includes(kw));

    if (!isConceptual) {
      return null;
    }

    let connection;
    try {
      connection = this.connectionRegistry.get(connectionId);
    } catch {
      return null;
    }
    const results = await this.vectorStore.search(message, 3, connection.getCapabilities().dbType);
    if (results.length === 0) {
      return null;
    }

    return results.map((r) => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
  }

  private isHelpCommand(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return ['help', '?', 'commands', 'what can you do'].includes(normalized);
  }

  private getHelpMessage(connectionId?: string): string {
    let dbType = 'DATABASE';
    try {
      const connection = this.connectionRegistry.get(connectionId);
      dbType = connection.getCapabilities().dbType.toUpperCase();
    } catch {
      // Use default if connection not found
    }
    return `I can help you monitor your ${dbType} database. Try asking:

**Server Status:**
- "How many clients are connected?"
- "What's the memory usage?"
- "How many keys are in the database?"
- "Show me server status"

**Performance:**
- "Show me slow commands"
- "Analyze slowlog patterns"
- "Run a latency diagnosis"
- "Run a memory diagnosis"

**Security & Analytics:**
- "Show me ACL failures"
- "Show client analytics"
- "Which clients are connected?"

Just ask naturally and I'll fetch the real-time data!`;
  }

  async indexDocumentation(docsPath: string): Promise<{ success: boolean; indexed?: number; failed?: number }> {
    if (!this.configService.get<boolean>('ai.enabled')) {
      return { success: false };
    }

    try {
      const result = await this.vectorStore.indexDocs(docsPath);
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`Documentation indexing failed: ${error instanceof Error ? error.message : 'Unknown'}`);
      return { success: false };
    }
  }

  async reloadDocs(): Promise<boolean> {
    return await this.vectorStore.reload();
  }
}
