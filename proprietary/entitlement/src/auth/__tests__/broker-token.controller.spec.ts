import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BrokerTokenController } from '../broker-token.controller';
import { BrokerApiGuard } from '../broker-api.guard';
import { BrokerSigningService } from '../broker-signing.service';

const BROKER_TOKEN = 'broker-secret-token';
const ADMIN_TOKEN = 'admin-secret-token';

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

describe('BrokerTokenController (HTTP)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.BROKER_API_TOKEN = BROKER_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.BROKER_SIGNING_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
    process.env.BROKER_SIGNING_KID = 'brk-test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [BrokerTokenController],
      providers: [BrokerApiGuard, BrokerSigningService],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects a request with no bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/broker-token',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects the ADMIN_API_TOKEN bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/broker-token',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(401);
  });

  it('accepts the BROKER_API_TOKEN bearer with a valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/broker-token',
      headers: { authorization: `Bearer ${BROKER_TOKEN}` },
      payload: VALID_BODY,
    });

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
