import { Controller, Post, Get, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ConnectionId, CONNECTION_ID_HEADER } from '@app/common/decorators';
import { ChatbotService } from './chatbot.service';
import { OllamaService } from './ollama.service';
import type { ChatMessage } from '@betterdb/shared';

class ChatMessageDto {
  @IsString()
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

class ChatRequestDto {
  @IsString()
  message: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
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
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to query' })
  @ApiResponse({ status: 200, description: 'AI response generated', type: ChatResponseDto })
  async chat(
    @Body() body: ChatRequestDto,
    @ConnectionId() connectionId?: string,
  ): Promise<ChatResponseDto> {
    const response = await this.chatbotService.chat(body.message, body.history, connectionId);
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
