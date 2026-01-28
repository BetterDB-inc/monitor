import { Test, TestingModule } from '@nestjs/testing';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HealthResponse, DatabaseCapabilities } from '@betterdb/shared';

export { HealthResponse, DatabaseCapabilities };

/** Minimum delay for connection cleanup in concurrent tests */
const CONNECTION_CLEANUP_MS = 50;

/**
 * Creates and initializes a NestJS Fastify application for testing.
 */
export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  // Enable validation pipes globally (same as main.ts)
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}

/**
 * Helper function to check if the test database is Valkey.
 */
export function isValkeyDatabase(healthResponse: HealthResponse): boolean {
  return healthResponse.database.type === 'valkey';
}

/**
 * Helper function to check if the test database is Redis.
 */
export function isRedisDatabase(healthResponse: HealthResponse): boolean {
  return healthResponse.database.type === 'redis';
}

/**
 * Helper to get database capabilities from health response.
 */
export function getDatabaseCapabilities(healthResponse: HealthResponse): DatabaseCapabilities | null {
  return healthResponse.capabilities;
}

/**
 * Wait for concurrent HTTP connections to close.
 * Use after parallel requests with Connection: close header.
 */
export function waitForConnectionCleanup(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, CONNECTION_CLEANUP_MS));
}
