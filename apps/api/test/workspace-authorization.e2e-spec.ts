import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { IncomingMessage, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import type { CliServerMessage } from '../src/cli/cli.types';
import { BETTER_AUTH, BetterAuthInstance } from '../src/auth/better-auth.factory';
import { READ_ONLY_MESSAGE } from '../src/auth/guards/mutation.guard';
import { CliGateway } from '../src/cli/cli.gateway';
import { MEMBER_READ_ONLY_MESSAGE } from '../src/cli/cli.service';
import { TailGateway } from '../src/monitor/tail.gateway';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const MEMBER_EMAIL = 'member@example.com';
const MEMBER_PASSWORD = 'member horse battery';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const LOCAL_CREDENTIAL_ISSUER = 'local:credential';

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
  'BETTERDB_UNSAFE_CLI',
];

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookies = ([] as string[]).concat(setCookie ?? []).join('\n');
  const [first] = cookies.split(';');
  return first;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', (error: Error) => {
      reject(error);
    });
  });
}

function waitForRejectedUpgrade(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      reject(new Error('Expected the upgrade to be rejected, but the socket opened'));
    });
  });
}

function waitForServerMessage(socket: WebSocket): Promise<CliServerMessage> {
  return new Promise<CliServerMessage>((resolve, reject) => {
    socket.once('message', (data: WebSocket.RawData) => {
      try {
        resolve(JSON.parse(data.toString()) as CliServerMessage);
      } catch (error) {
        reject(error as Error);
      }
    });
    socket.once('error', (error: Error) => {
      reject(error);
    });
  });
}

describe('Workspace authorization (E2E)', () => {
  let app: NestFastifyApplication;
  let port: number;
  let ownerCookie: string;
  let memberCookie: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-authorization-${Date.now()}.db`);
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.BETTERDB_DATA_DIR = '';
    process.env.STORAGE_TYPE = 'sqlite';
    process.env.STORAGE_SQLITE_FILEPATH = sqlitePath;
    process.env.AUTH_PUBLIC_URL = TRUSTED_ORIGIN;
    process.env.BETTERDB_UNSAFE_CLI = 'true';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'ingest/*splat', method: RequestMethod.ALL },
        { path: 'v1/traces', method: RequestMethod.POST },
      ],
    });

    const cliGateway = app.get(CliGateway);
    const tailGateway = app.get(TailGateway);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const httpServer = app.getHttpServer() as Server;
    httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname === '/cli/ws' || url.pathname === '/api/cli/ws') {
        cliGateway.handleUpgrade(request, socket, head);
        return;
      }
      if (url.pathname === '/monitor/ws' || url.pathname === '/api/monitor/ws') {
        tailGateway.handleUpgrade(request, socket, head);
        return;
      }
      socket.destroy();
    });

    await app.listen(0, '127.0.0.1');
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the HTTP server to expose a network address');
    }
    port = (address as AddressInfo).port;

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: '198.51.100.90',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: OWNER,
    });
    if (signUp.statusCode !== 200) {
      throw new Error(`Owner sign-up failed: ${signUp.statusCode} ${signUp.body}`);
    }
    ownerCookie = extractSessionCookie(signUp.headers['set-cookie']);

    const auth = app.get<BetterAuthInstance>(BETTER_AUTH);
    const context = await auth.$context;
    const hashedPassword = await context.password.hash(MEMBER_PASSWORD);
    const member = await context.internalAdapter.createUser(
      {
        email: MEMBER_EMAIL,
        name: 'Member',
        emailVerified: false,
        role: 'member',
        isOwner: false,
      },
      { method: 'email-password' } as never,
    );
    await context.internalAdapter.linkAccount({
      userId: member.id,
      providerId: 'credential',
      issuer: LOCAL_CREDENTIAL_ISSUER,
      accountId: member.id,
      password: hashedPassword,
    });

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: '198.51.100.91',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    if (signIn.statusCode !== 200) {
      throw new Error(`Member sign-in failed: ${signIn.statusCode} ${signIn.body}`);
    }
    memberCookie = extractSessionCookie(signIn.headers['set-cookie']);
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.on('error', () => {
        return undefined;
      });
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }
    if (app !== undefined) {
      await app.close();
    }
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(sqlitePath, { force: true });
  });

  it('lets a member list connections', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('reports the member role from workspace/me', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ role: 'member' }));
  });

  it('blocks a member from resetting settings', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(expect.objectContaining({ message: READ_ONLY_MESSAGE }));
  });

  it('lets the owner reset settings', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(201);
  });

  it('lets member vector-search requests reach validation instead of the mutation guard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vector-search/indexes/x/search',
      headers: { cookie: memberCookie, 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a CLI socket upgrade without a session', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cli/ws`);
    openSockets.push(socket);
    const statusCode = await waitForRejectedUpgrade(socket);
    expect(statusCode).toBe(401);
  });

  it('rejects a monitor tail socket upgrade without a session', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/monitor/ws?sessionId=nope`);
    openSockets.push(socket);
    const statusCode = await waitForRejectedUpgrade(socket);
    expect(statusCode).toBe(401);
  });

  it('lets a signed-in member run only read commands over the CLI socket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cli/ws`, {
      headers: { cookie: memberCookie },
    });
    openSockets.push(socket);
    await waitForOpen(socket);
    const responsePromise = waitForServerMessage(socket);
    socket.send(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'none' }));
    const message = await responsePromise;
    if (message.type !== 'error') {
      throw new Error(`Expected an error message, got: ${JSON.stringify(message)}`);
    }
    expect(message.error).toContain(MEMBER_READ_ONLY_MESSAGE);
  });

  it('does not read-only-restrict the owner over the CLI socket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cli/ws`, {
      headers: { cookie: ownerCookie },
    });
    openSockets.push(socket);
    await waitForOpen(socket);
    const responsePromise = waitForServerMessage(socket);
    socket.send(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'none' }));
    const message = await responsePromise;
    if (message.type !== 'error') {
      throw new Error(`Expected an error message, got: ${JSON.stringify(message)}`);
    }
    expect(message.error).not.toContain(MEMBER_READ_ONLY_MESSAGE);
  });
});
