import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OllamaService } from './ollama.service';
import { VectorStoreService } from './vector-store.service';
import { ChatbotService } from './chatbot.service';
import { ChatbotController } from './chatbot.controller';

// Import modules from main app using path aliases
import { MetricsModule } from '@app/metrics/metrics.module';
import { StorageModule } from '@app/storage/storage.module';
import { ClientAnalyticsModule } from '@app/client-analytics/client-analytics.module';

@Module({
  imports: [ConfigModule, MetricsModule, StorageModule, ClientAnalyticsModule],
  providers: [OllamaService, VectorStoreService, ChatbotService],
  controllers: [ChatbotController],
  exports: [ChatbotService],
})
export class AiModule {}
