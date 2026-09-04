import {
  CanActivate,
  ConflictException,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@betterdb/shared';
import type { RequestWithActor } from '../auth/guards/actor.guard';
import { ActivityInterceptor } from './activity.interceptor';
import { ActivityService } from './activity.service';

const admin: Actor = {
  userId: 'u1',
  email: 'owner@example.com',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
};

@Injectable()
class HeaderActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    request.actor = request.headers['x-test-actor'] === 'admin' ? admin : null;
    return true;
  }
}

@Controller('connections')
class ConnectionsStubController {
  @Post()
  create(): { id: string } {
    return { id: 'c1' };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(): void {
    return undefined;
  }

  @Post('fail')
  fail(): never {
    throw new ConflictException('nope');
  }

  @Post('raw')
  raw(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    reply.status(202).send({ accepted: req.method });
  }

  @Get()
  list(): string[] {
    return [];
  }
}

@Controller('auth')
class AuthStubController {
  @Post('sign-in/email')
  signIn(): { ok: true } {
    return { ok: true };
  }
}

describe('ActivityInterceptor', () => {
  let app: NestFastifyApplication;
  let record: jest.Mock;

  beforeAll(async () => {
    record = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectionsStubController, AuthStubController],
      providers: [
        { provide: ActivityService, useValue: { record } },
        { provide: APP_GUARD, useClass: HeaderActorGuard },
        { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    record.mockClear();
  });

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  it('records a mapped mutation with the created id, connection header and default 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { 'x-test-actor': 'admin', 'x-connection-id': 'conn-9' },
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    await settle();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      actor: { userId: 'u1', email: 'owner@example.com', via: 'session', tokenId: null },
      action: 'connection.create',
      statusCode: 201,
      ip: '127.0.0.1',
      connectionId: 'conn-9',
      targetType: 'connection',
      targetId: 'c1',
      details: { method: 'POST', path: '/connections' },
    });
  });

  it('records the reply status set from @HttpCode and the route param as the target', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/api/connections/c7',
      headers: { 'x-test-actor': 'admin' },
    });
    await settle();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'connection.delete',
        statusCode: 204,
        targetType: 'connection',
        targetId: 'c7',
        connectionId: null,
        details: { method: 'DELETE', path: '/connections/c7' },
      }),
    );
  });

  it('records the HttpException status when the handler throws', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections/fail',
      headers: { 'x-test-actor': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    await settle();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'POST /connections/fail', statusCode: 409 }),
    );
  });

  it('reads the status from the reply when the handler sent it directly', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/connections/raw',
      headers: { 'x-test-actor': 'admin' },
      payload: {},
    });
    await settle();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'POST /connections/raw', statusCode: 202 }),
    );
  });

  it('skips reads, anonymous requests and public paths', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { 'x-test-actor': 'admin' },
    });
    await app.inject({ method: 'POST', url: '/api/connections', payload: {} });
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'x-test-actor': 'admin' },
      payload: {},
    });
    await settle();
    expect(record).not.toHaveBeenCalled();
  });
});
