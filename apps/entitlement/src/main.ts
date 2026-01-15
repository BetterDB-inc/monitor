import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const fastifyAdapter = new FastifyAdapter();

  fastifyAdapter.getInstance().addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    fastifyAdapter,
    { logger: ['log', 'error', 'warn', 'debug'], rawBody: true },
  );

  const config = app.get(ConfigService);
  const port = config.get('PORT', 3001);
  const host = config.get('HOST', '0.0.0.0');

  await app.listen(port, host);
  logger.log(`Entitlement server running on http://${host}:${port}`);
}

bootstrap();
