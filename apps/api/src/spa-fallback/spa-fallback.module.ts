import { Module } from '@nestjs/common';
import { SpaFallbackController } from './spa-fallback.controller';

/**
 * SPA Fallback Module
 *
 * Provides a catch-all controller for serving index.html in production.
 * This module must be imported LAST in AppModule to ensure the wildcard
 * route has lowest priority.
 */
@Module({
  controllers: [SpaFallbackController],
})
export class SpaFallbackModule {}
