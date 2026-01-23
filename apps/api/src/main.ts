import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { join } from 'path';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'fs';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap(): Promise<void> {
  // Type assertion required due to NestJS/Fastify adapter version mismatch during transition
  const app = await (NestFactory.create as Function)(
    AppModule,
    new FastifyAdapter(),
  ) as NestFastifyApplication;

  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    // Set global prefix for API routes FIRST
    app.setGlobalPrefix('api');

    // Serve static files in production (path adjusted for Docker dist structure)
    const publicPath = join(__dirname, '..', '..', '..', '..', 'public');
    const indexPath = join(publicPath, 'index.html');

    // Read index.html once at startup
    const indexHtml = readFileSync(indexPath, 'utf-8');

    await app.register(fastifyStatic, {
      root: publicPath,
      prefix: '/',
      wildcard: false, // Disable wildcard matching to avoid conflict
    });

    // SPA fallback - manually handle non-API, non-static file routes
    const fastifyInstance = app.getHttpAdapter().getInstance();
    fastifyInstance.get('/*', async (request, reply) => {
      // Don't handle API routes
      if (request.url.startsWith('/api')) {
        return;
      }

      // Check if it's a static asset request (has file extension)
      const urlPath = request.url.split('?')[0];
      if (urlPath.match(/\.[a-z0-9]+$/i)) {
        // Let fastify-static handle it
        return;
      }

      // Serve index.html for all other routes (SPA fallback)
      reply.type('text/html').send(indexHtml);
    });
  } else {
    // Development mode - enable CORS
    app.enableCors({
      origin: 'http://localhost:5173',
      credentials: true,
    });
  }

  // Setup Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('BetterDB Monitor API')
    .setDescription('Valkey/Redis monitoring and observability API')
    .setVersion('0.1.1')
    .addTag('metrics', 'Valkey/Redis metrics and diagnostics')
    .addTag('audit', 'ACL audit trail and security events')
    .addTag('client-analytics', 'Client connection history and analytics')
    .addTag('prometheus', 'Prometheus metrics endpoint')
    .addTag('health', 'Health check endpoint')
    .build();

  const document = SwaggerModule.createDocument(app as unknown as INestApplication, config);
  SwaggerModule.setup('docs', app as unknown as INestApplication, document);

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`API server running on http://localhost:${port}`);
  if (isProduction) {
    console.log('Serving frontend from /public');
    console.log(`API documentation available at http://localhost:${port}/api/docs`);
  } else {
    console.log(`API documentation available at http://localhost:${port}/docs`);
  }
}

bootstrap();
