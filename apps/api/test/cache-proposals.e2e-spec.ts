import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Redis from 'iovalkey';
import { prodAgentThreeTools } from '@betterdb/cache-fixtures';
import { createTestApp } from './test-utils';
import { CacheProposalService } from '../src/cache-proposals/cache-proposal.service';

const VALKEY_BUNDLE_HOST = process.env.TEST_VALKEY_BUNDLE_HOST ?? 'localhost';
const VALKEY_BUNDLE_PORT = Number(process.env.TEST_VALKEY_BUNDLE_PORT ?? '6391');
const CACHE_NAME = 'cache-proposals-e2e-agent';

describe('Cache Proposals E2E - tool_ttl_adjust happy path', () => {
  let app: NestFastifyApplication;
  let connectionId: string;
  let cacheValkey: Redis;

  beforeAll(async () => {
    await prodAgentThreeTools.run({
      valkeyHost: VALKEY_BUNDLE_HOST,
      valkeyPort: VALKEY_BUNDLE_PORT,
      cacheName: CACHE_NAME,
      embedFn: async () => [],
    });

    app = await createTestApp();

    const res = await request(app.getHttpServer())
      .post('/connections')
      .send({
        name: 'cache-proposals-e2e-bundle',
        host: VALKEY_BUNDLE_HOST,
        port: VALKEY_BUNDLE_PORT,
      });
    expect([200, 201]).toContain(res.status);
    connectionId = res.body.id;

    cacheValkey = new Redis({ host: VALKEY_BUNDLE_HOST, port: VALKEY_BUNDLE_PORT });
  }, 60_000);

  afterAll(async () => {
    if (connectionId) {
      await request(app.getHttpServer()).delete(`/connections/${connectionId}`);
    }
    if (cacheValkey) {
      await cacheValkey.quit();
    }
    if (app) {
      await app.close();
    }
  });

  it('approves a tool_ttl_adjust proposal and updates the persisted tool policy', async () => {
    const service = app.get(CacheProposalService);

    const beforePolicy = await readPolicy(cacheValkey, CACHE_NAME, 'weather_lookup');
    expect(beforePolicy.ttl).toBe(60);

    const proposeResult = await service.proposeToolTtlAdjust(connectionId, {
      cacheName: CACHE_NAME,
      toolName: 'weather_lookup',
      newTtlSeconds: 600,
      reasoning: 'Weather data is stable for 10 minutes; raising TTL from 60s to 600s.',
      proposedBy: 'integration-test',
    });
    const proposalId = proposeResult.proposal.id;
    expect(proposeResult.proposal.status).toBe('pending');

    const approveRes = await request(app.getHttpServer())
      .post(`/cache-proposals/${proposalId}/approve`)
      .send({ actor: 'integration-test' })
      .set('X-Connection-Id', connectionId);
    expect([200, 201]).toContain(approveRes.status);

    expect(approveRes.body.status).toBe('applied');
    expect(approveRes.body.applied_result).toMatchObject({
      success: true,
      details: {
        tool_name: 'weather_lookup',
        previous_value: 60,
        new_value: 600,
      },
    });

    const afterPolicy = await readPolicy(cacheValkey, CACHE_NAME, 'weather_lookup');
    expect(afterPolicy.ttl).toBe(600);
  });
});

async function readPolicy(
  client: Redis,
  cacheName: string,
  toolName: string,
): Promise<{ ttl: number }> {
  const raw = await client.hget(`${cacheName}:__tool_policies`, toolName);
  if (raw === null) {
    throw new Error(`No policy found for tool ${toolName}`);
  }
  return JSON.parse(raw) as { ttl: number };
}
