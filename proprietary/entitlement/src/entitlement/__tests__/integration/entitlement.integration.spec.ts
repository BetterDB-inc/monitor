import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { EntitlementModule } from '../../entitlement.module';
import { HealthModule } from '../../../health/health.module';
import { PrismaService } from '../../../prisma/prisma.service';
import type { EntitlementResponse } from '@betterdb/shared';

const TEST_LICENSE_KEY = 'integration-test-key-1234567890';
const EXPIRED_LICENSE_KEY = 'expired-test-key-123456789012';

describe('Entitlement (integration)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let testCustomerId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        EntitlementModule,
        HealthModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);

    // Seed test data
    const customer = await prisma.customer.create({
      data: { email: 'integration-test@example.com', name: 'Integration Test' },
    });
    testCustomerId = customer.id;

    await prisma.license.createMany({
      data: [
        {
          key: TEST_LICENSE_KEY,
          customerId: testCustomerId,
          tier: 'pro',
          active: true,
        },
        {
          key: EXPIRED_LICENSE_KEY,
          customerId: testCustomerId,
          tier: 'pro',
          active: true,
          expiresAt: new Date('2020-01-01'),
        },
      ],
    });
  });

  afterAll(async () => {
    if (testCustomerId) {
      await prisma.license.deleteMany({ where: { customerId: testCustomerId } });
      await prisma.customer.delete({ where: { id: testCustomerId } });
    }
    await app?.close();
  });

  describe('GET /health', () => {
    it('returns healthy when DB is connected', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('healthy');
      expect(body.database).toBe('connected');
    });
  });

  describe('POST /v1/entitlements', () => {
    it('returns community tier for keyless requests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entitlements',
        payload: {
          instanceId: 'integration-test-instance',
          eventType: 'license_check',
          stats: { version: '1.0.0', platform: 'linux' },
        },
      });

      expect(res.statusCode).toBe(201);
      const body: EntitlementResponse = res.json();
      expect(body.valid).toBe(true);
      expect(body.tier).toBe('community');
    });

    it('validates a valid pro license key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entitlements',
        payload: {
          licenseKey: TEST_LICENSE_KEY,
          instanceId: 'integration-test-instance',
          eventType: 'license_check',
        },
      });

      expect(res.statusCode).toBe(201);
      const body: EntitlementResponse = res.json();
      expect(body.valid).toBe(true);
      expect(body.tier).toBe('pro');
      expect(body.customer).toBeDefined();
      expect(body.customer!.email).toBe('integration-test@example.com');
    });

    it('rejects an invalid license key with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entitlements',
        payload: {
          licenseKey: 'nonexistent-key-1234567890',
          instanceId: 'integration-test-instance',
          eventType: 'license_check',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns expired error for expired license', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entitlements',
        payload: {
          licenseKey: EXPIRED_LICENSE_KEY,
          instanceId: 'integration-test-instance',
          eventType: 'license_check',
        },
      });

      expect(res.statusCode).toBe(201);
      const body: EntitlementResponse = res.json();
      expect(body.valid).toBe(false);
      expect(body.tier).toBe('community');
      expect(body.error).toContain('expired');
    });

    it('rejects malformed (too short) license key with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entitlements',
        payload: {
          licenseKey: 'short',
          instanceId: 'integration-test-instance',
          eventType: 'license_check',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
