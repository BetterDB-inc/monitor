import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BrokerTokenController } from '../broker-token.controller';
import { BrokerApiGuard } from '../broker-api.guard';
import { BrokerThrottlerGuard } from '../broker-throttler.guard';
import { BrokerSigningService } from '../broker-signing.service';
import { EmailThrottlerGuard } from '../../common/email-throttler.guard';

const BROKER_TOKEN = 'broker-secret-token';
const ADMIN_TOKEN = 'admin-secret-token';
const BROKER_LIMIT = 60;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const VALID_BODY = {
  email: 'owner@example.com',
  provider: 'google',
  providerId: 'g-1',
  aud: 'http://localhost:3001',
  state: 'A'.repeat(43),
};

async function createApp(): Promise<NestFastifyApplication> {
  process.env.BROKER_API_TOKEN = BROKER_TOKEN;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.BROKER_SIGNING_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
  process.env.BROKER_SIGNING_KID = 'brk-test';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([{ ttl: 60000, limit: 20 }]),
    ],
    controllers: [BrokerTokenController],
    providers: [
      BrokerApiGuard,
      BrokerThrottlerGuard,
      BrokerSigningService,
      { provide: APP_GUARD, useClass: EmailThrottlerGuard },
    ],
  }).compile();

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function post(app: NestFastifyApplication, token: string | null, remoteAddress = '127.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/auth/broker-token',
    remoteAddress,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: VALID_BODY,
  });
}

describe('BrokerTokenController (HTTP)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects a request with no bearer token', async () => {
    const res = await post(app, null);

    expect(res.statusCode).toBe(401);
  });

  it('rejects the ADMIN_API_TOKEN bearer', async () => {
    const res = await post(app, ADMIN_TOKEN);

    expect(res.statusCode).toBe(401);
  });

  it('accepts the BROKER_API_TOKEN bearer with a valid body', async () => {
    const res = await post(app, BROKER_TOKEN);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('token');
  });

  it('rejects the BROKER_API_TOKEN bearer with an invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/broker-token',
      headers: { authorization: `Bearer ${BROKER_TOKEN}` },
      payload: { ...VALID_BODY, provider: 'gitlab' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('BrokerTokenController rate limit (HTTP)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 429 once authorized calls exceed the limit, whatever the caller IP', async () => {
    for (let i = 0; i < BROKER_LIMIT; i++) {
      const res = await post(app, BROKER_TOKEN, `10.0.0.${(i % 250) + 1}`);
      expect(res.statusCode).toBe(201);
    }

    const res = await post(app, BROKER_TOKEN, '10.0.1.1');

    expect(res.statusCode).toBe(429);
  });

  it('does not charge unauthorized calls against the allowance', async () => {
    for (let i = 0; i <= BROKER_LIMIT; i++) {
      const res = await post(app, ADMIN_TOKEN);
      expect(res.statusCode).toBe(401);
    }

    const res = await post(app, BROKER_TOKEN);

    expect(res.statusCode).toBe(201);
  });
});
