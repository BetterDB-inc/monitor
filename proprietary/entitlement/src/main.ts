import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const fastifyAdapter = new FastifyAdapter();

  // Type assertion required due to NestJS/Fastify adapter version mismatch during transition
  const app = await (NestFactory.create as Function)(
    AppModule,
    fastifyAdapter,
    { logger: ['log', 'error', 'warn', 'debug'], rawBody: true },
  ) as NestFastifyApplication;

  const config = app.get(ConfigService);
  const port = config.get('PORT', 3001);
  const host = config.get('HOST', '0.0.0.0');

  const corsOrigins = config.get('CORS_ORIGINS', 'https://betterdb.com,http://localhost:3001');
  app.enableCors({
    origin: corsOrigins.split(',').map((o: string) => o.trim()),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  });

  await app.listen(port, host);
  logger.log(`Entitlement server running on http://${host}:${port}`);
}

bootstrap();
