import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { join } from 'path';
import { readFileSync } from 'fs';
import fastifyStatic from '@fastify/static';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validateEnv } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Validate environment variables before anything else
  validateEnv();

  const isProduction = process.env.NODE_ENV === 'production';

  const fastifyAdapter = new FastifyAdapter();

  // Compute publicPath once to avoid divergence between SPA fallback and static file serving
  const publicPath = isProduction
    ? (process.env.BETTERDB_STATIC_DIR || join(__dirname, '..', '..', '..', '..', 'public'))
    : null;

  // In production, register SPA fallback at Fastify level BEFORE NestJS routes
  // This gives it lowest priority - NestJS routes (including /api/*) will match first
  if (isProduction && publicPath) {
    const indexPath = join(publicPath, 'index.html');
    const indexHtml = readFileSync(indexPath, 'utf-8');
    const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt)$/i;

    const fastifyInstance = fastifyAdapter.getInstance();

    // Register catch-all route with wildcard - has lowest priority
    // Don't register HEAD - let Fastify auto-handle it for healthchecks
    fastifyInstance.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      url: '/*',
      handler: (request, reply) => {
        const urlPath = request.url.split('?')[0];

        // API routes return JSON 404 (though they should match NestJS routes first)
        if (urlPath.startsWith('/api/')) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found' });
          return;
        }

        // Static files return 404
        if (STATIC_EXTENSIONS.test(urlPath)) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found' });
          return;
        }

        // Only serve SPA HTML for GET requests
        if (request.method !== 'GET') {
          reply.code(404).send({ statusCode: 404, error: 'Not Found' });
          return;
        }

        // Serve index.html for SPA client-side routes
        reply.type('text/html').send(indexHtml);
      }
    });
  }

  // Type assertion required due to NestJS/Fastify adapter version mismatch during transition
  const app = await (NestFactory.create as Function)(
    AppModule,
    fastifyAdapter,
  ) as NestFastifyApplication;

  // Enable validation pipes globally
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  if (isProduction && publicPath) {
    // Set global prefix for API routes
    // SPA fallback is registered at Fastify level before NestJS, so no exclusion needed
    app.setGlobalPrefix('api');

    // Serve static files from public directory (publicPath computed above)
    const fastifyInstance = app.getHttpAdapter().getInstance();
    await fastifyInstance.register(fastifyStatic, {
      root: publicPath,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
    });
  } else {
    // Development mode - enable CORS for any localhost port
    app.enableCors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        // Allow any localhost origin
        if (origin.match(/^http:\/\/localhost:\d+$/)) {
          return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'), false);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
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
  }
  console.log(`API documentation available at http://localhost:${port}/docs`);

  // Show GitHub star request
  console.log('');
  console.log('─────────────────────────────────────────────────');
  console.log('');
  console.log('★ If you find BetterDB Monitor useful, please consider');
  console.log('  giving us a star on GitHub:');
  console.log('');
  console.log('  https://github.com/BetterDB-Inc/monitor');
  console.log('');
}

bootstrap();
