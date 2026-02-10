import { Module } from '@nestjs/common';
import { SpaFallbackController } from './spa-fallback.controller';

/**
 * SPA Fallback Module
 * 
 * This module MUST be imported LAST in AppModule so the catch-all route
 * has the lowest priority and doesn't override API routes.
 */
@Module({
  controllers: [SpaFallbackController],
})
export class SpaFallbackModule { }
