import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { join } from 'path';
import { readFileSync } from 'fs';
import fastifyStatic from '@fastify/static';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validateEnv } from './config/env.schema';
import { categorizeError } from './common/utils/error-categorizer';

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

  // Register cloud auth middleware at Fastify level BEFORE any other middleware
  // This ensures it runs before static file serving
  if (process.env.CLOUD_MODE) {
    try {
      const { CloudAuthMiddleware } = require('../../../proprietary/cloud-auth/cloud-auth.middleware');
      const middleware = new CloudAuthMiddleware();
      app.use((req: any, res: any, next: () => void) => middleware.use(req, res, next));
      console.log('[CloudAuth] Middleware registered at Fastify level');
    } catch {
      console.warn('[CloudAuth] Failed to register middleware — proprietary module not found');
    }
  }

  // Register startup error handlers — report fatal errors within the first 60s
  let licenseService: { sendStartupError(msg: string, cat: string): Promise<void> } | null = null;
  try {
    const { LicenseService } = require('../../../proprietary/license/license.service');
    licenseService = app.get(LicenseService);
  } catch {
    // LicenseService not available — skip startup error reporting
  }

  const reportStartupErrorAndExit = async (error: Error) => {
    if (process.uptime() > 60) {
      return;
    }
    const category = categorizeError(error);
    console.error(`[Startup Error] ${category}: ${error.message}`);
    if (licenseService) {
      try {
        await licenseService.sendStartupError(error.message, category);
      } catch {
        // Best-effort
      }
    }
    process.exit(1);
  };

  process.on('uncaughtException', (error: Error) => {
    reportStartupErrorAndExit(error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    reportStartupErrorAndExit(error);
  });

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

  // Register WebSocket upgrade handler for agent connections (cloud mode only)
  if (process.env.CLOUD_MODE) {
    try {
      const { AgentGateway } = require('../../../proprietary/agent/agent-gateway');
      const agentGateway = app.get(AgentGateway);
      const httpServer = app.getHttpServer();

      httpServer.on('upgrade', (request: any, socket: any, head: any) => {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        if (url.pathname === '/agent/ws' || url.pathname === '/api/agent/ws') {
          agentGateway.handleUpgrade(request, socket, head);
        } else {
          // Not an agent WebSocket — destroy to prevent hanging
          socket.destroy();
        }
      });

      console.log('[Agent] WebSocket upgrade handler registered');
    } catch {
      console.warn('[Agent] Failed to register WebSocket handler — module not available');
    }
  }

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`API server running on http://localhost:${port}`);
  if (isProduction) {
    console.log('Serving frontend from /public');
  }
  console.log(`API documentation available at http://localhost:${port}/docs`);

  // Report startup connection errors to telemetry (best-effort, non-blocking)
  if (licenseService) {
    try {
      const { ConnectionRegistry } = require('./connections/connection-registry.service');
      const registry = app.get(ConnectionRegistry);
      const connectionErrors = registry.getStartupConnectionErrors();
      for (const connErr of connectionErrors) {
        const category = categorizeError(new Error(connErr.error));
        console.error(`[Startup Error] ${category}: ${connErr.name} (${connErr.host}:${connErr.port}) — ${connErr.error}`);
        licenseService.sendStartupError(
          `${connErr.name} (${connErr.host}:${connErr.port}): ${connErr.error}`,
          category,
        ).catch(() => { /* best-effort */ });
      }
    } catch {
      // ConnectionRegistry not available — skip
    }
  }

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
