import { Controller, Post, Get, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ChatbotService } from './chatbot.service';
import { OllamaService } from './ollama.service';
import type { ChatMessage } from '@betterdb/shared';

class ChatRequestDto {
  message: string;
  history?: ChatMessage[];
}

class ChatResponseDto {
  response: string;
}

class IndexDocsRequestDto {
  path: string;
}

class IndexDocsResponseDto {
  success: boolean;
  indexed?: number;
  failed?: number;
}

@Controller('ai')
@ApiTags('AI Assistant')
export class ChatbotController {
  constructor(
    private chatbotService: ChatbotService,
    private ollamaService: OllamaService,
  ) {}

  @Post('chat')
  @ApiOperation({ summary: 'Chat with AI assistant' })
  @ApiResponse({ status: 200, description: 'AI response generated', type: ChatResponseDto })
  async chat(@Body() body: ChatRequestDto): Promise<ChatResponseDto> {
    const response = await this.chatbotService.chat(body.message, body.history);
    return { response };
  }

  @Post('index-docs')
  @ApiOperation({ summary: 'Index Valkey documentation for RAG' })
  @ApiResponse({ status: 200, description: 'Documentation indexed', type: IndexDocsResponseDto })
  async indexDocs(@Body() body: IndexDocsRequestDto): Promise<IndexDocsResponseDto> {
    return await this.chatbotService.indexDocumentation(body.path);
  }

  @Get('health')
  @ApiOperation({ summary: 'Check AI service health' })
  @ApiResponse({ status: 200, description: 'Service status' })
  async health(): Promise<{ status: string }> {
    return { status: 'ok' };
  }

  @Post('warmup')
  @ApiOperation({ summary: 'Warm up AI models (loads them into memory)' })
  @ApiResponse({ status: 200, description: 'Models warmed up' })
  async warmup(): Promise<{ success: boolean; message: string }> {
    try {
      await this.ollamaService.warmupModels();
      const keepAlive = this.ollamaService.getKeepAlive();
      return {
        success: true,
        message: `Models warmed up successfully (will stay loaded for ${keepAlive})`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to warm up models: ${error.message}`,
      };
    }
  }

  @Post('reload-docs')
  @ApiOperation({ summary: 'Reload documentation vector store' })
  @ApiResponse({ status: 200, description: 'Documentation reloaded' })
  async reloadDocs(): Promise<{ success: boolean; message: string }> {
    const success = await this.chatbotService.reloadDocs();
    return {
      success,
      message: success
        ? 'Documentation reloaded successfully'
        : 'Failed to reload. Run "pnpm docs:index" first.',
    };
  }
}
