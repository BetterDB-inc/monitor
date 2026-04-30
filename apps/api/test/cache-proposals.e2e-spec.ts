import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Redis from 'iovalkey';
import {
  prodAgentThreeTools,
  agentInvalidateByTool,
  agentInvalidateBySession,
  faqCacheBimodal,
  semanticInvalidateByModel,
  createEmbedder,
} from '@betterdb/cache-fixtures';
import { createTestApp } from './test-utils';
import { CacheProposalService } from '../src/cache-proposals/cache-proposal.service';

const VALKEY_BUNDLE_HOST = process.env.TEST_VALKEY_BUNDLE_HOST ?? 'localhost';
const VALKEY_BUNDLE_PORT = Number(process.env.TEST_VALKEY_BUNDLE_PORT ?? '6391');

const NOOP_EMBED = async () => [];

async function ollamaReachable(): Promise<boolean> {
  const url = `${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}/api/tags`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('Cache Proposals E2E', () => {
  let app: NestFastifyApplication;
  let connectionId: string;
  let cacheValkey: Redis;

  beforeAll(async () => {
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

  describe('tool_ttl_adjust', () => {
    const cacheName = 'e2e-agent-ttl';

    beforeAll(async () => {
      await prodAgentThreeTools.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('approves via HTTP and updates the persisted tool policy in Valkey', async () => {
      const service = app.get(CacheProposalService);

      const beforePolicy = await readPolicy(cacheValkey, cacheName, 'weather_lookup');
      expect(beforePolicy.ttl).toBe(60);

      const proposeResult = await service.proposeToolTtlAdjust(connectionId, {
        cacheName,
        toolName: 'weather_lookup',
        newTtlSeconds: 600,
        reasoning: 'Weather data is stable for 10 minutes; raising TTL from 60s to 600s.',
        proposedBy: 'integration-test',
      });
      expect(proposeResult.proposal.status).toBe('pending');

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
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

      const afterPolicy = await readPolicy(cacheValkey, cacheName, 'weather_lookup');
      expect(afterPolicy.ttl).toBe(600);
    });
  });

  describe('agent_cache invalidate by tool', () => {
    const cacheName = 'e2e-invalidate-by-tool';
    const TARGET_TOOL = 'classify_intent';

    beforeAll(async () => {
      process.env.AGENT_INVALIDATE_PER_TOOL = '20';
      await agentInvalidateByTool.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('removes only the targeted tool entries and reports actual_affected', async () => {
      const service = app.get(CacheProposalService);

      const beforeTarget = await countToolEntries(cacheValkey, cacheName, TARGET_TOOL);
      const beforeOther = await countToolEntries(cacheValkey, cacheName, 'sentiment_score');
      expect(beforeTarget).toBe(20);
      expect(beforeOther).toBe(20);

      const proposeResult = await service.proposeInvalidate(connectionId, {
        cacheName,
        filterKind: 'tool',
        filterValue: TARGET_TOOL,
        estimatedAffected: 20,
        reasoning: 'Bad model version; invalidating classify_intent so callers re-run.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      expect(approveRes.body.applied_result.success).toBe(true);
      expect(approveRes.body.applied_result.details).toMatchObject({
        filter_kind: 'tool',
        tool_name: TARGET_TOOL,
      });

      const afterTarget = await countToolEntries(cacheValkey, cacheName, TARGET_TOOL);
      const afterOther = await countToolEntries(cacheValkey, cacheName, 'sentiment_score');
      expect(afterTarget).toBe(0);
      expect(afterOther).toBe(20);
    });
  });

  describe('reject flow', () => {
    const cacheName = 'e2e-reject';

    beforeAll(async () => {
      await prodAgentThreeTools.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('records rejection with reason and leaves Valkey state untouched', async () => {
      const service = app.get(CacheProposalService);

      const proposeResult = await service.proposeToolTtlAdjust(connectionId, {
        cacheName,
        toolName: 'lookup_user',
        newTtlSeconds: 1800,
        reasoning: 'Inflate TTL to 30 minutes — operator considers this risky.',
      });
      const proposalId = proposeResult.proposal.id;

      const rejectRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposalId}/reject`)
        .send({ reason: 'Risk of stale plan data', actor: 'integration-test' })
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(rejectRes.status);
      expect(rejectRes.body).toMatchObject({
        proposal_id: proposalId,
        status: 'rejected',
      });

      const detailRes = await request(app.getHttpServer())
        .get(`/cache-proposals/${proposalId}`)
        .set('X-Connection-Id', connectionId)
        .expect(200);

      expect(detailRes.body.proposal.status).toBe('rejected');
      const rejectedAudit = (detailRes.body.audit as Array<{
        event_type: string;
        event_payload?: { reason?: string } | null;
      }>).find((entry) => entry.event_type === 'rejected');
      expect(rejectedAudit?.event_payload).toMatchObject({ reason: 'Risk of stale plan data' });

      const policy = await readPolicy(cacheValkey, cacheName, 'lookup_user');
      expect(policy.ttl).toBe(600);
    });
  });

  describe('agent_cache invalidate by session', () => {
    const cacheName = 'e2e-invalidate-by-session';
    const TARGET_SESSION = 'sess-alpha';

    beforeAll(async () => {
      await agentInvalidateBySession.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('removes only the targeted session and leaves the others intact', async () => {
      const service = app.get(CacheProposalService);

      const beforeAlpha = await countSessionKeys(cacheValkey, cacheName, TARGET_SESSION);
      const beforeBravo = await countSessionKeys(cacheValkey, cacheName, 'sess-bravo');
      expect(beforeAlpha).toBeGreaterThan(0);
      expect(beforeBravo).toBeGreaterThan(0);

      const proposeResult = await service.proposeInvalidate(connectionId, {
        cacheName,
        filterKind: 'session',
        filterValue: TARGET_SESSION,
        estimatedAffected: beforeAlpha,
        reasoning: 'Test session ended; clearing turn history.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      expect(approveRes.body.applied_result.details).toMatchObject({
        filter_kind: 'session',
        session_id: TARGET_SESSION,
      });

      const afterAlpha = await countSessionKeys(cacheValkey, cacheName, TARGET_SESSION);
      const afterBravo = await countSessionKeys(cacheValkey, cacheName, 'sess-bravo');
      expect(afterAlpha).toBe(0);
      expect(afterBravo).toBe(beforeBravo);
    });
  });

  describe('agent_cache invalidate by key_prefix', () => {
    const cacheName = 'e2e-invalidate-by-key-prefix';

    beforeAll(async () => {
      await prodAgentThreeTools.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('removes only entries under the prefix and leaves siblings intact', async () => {
      const service = app.get(CacheProposalService);

      const beforeWeather = await countToolEntries(cacheValkey, cacheName, 'weather_lookup');
      const beforeOther = await countToolEntries(cacheValkey, cacheName, 'classify_intent');
      expect(beforeWeather).toBeGreaterThan(0);
      expect(beforeOther).toBeGreaterThan(0);

      const proposeResult = await service.proposeInvalidate(connectionId, {
        cacheName,
        filterKind: 'key_prefix',
        filterValue: 'tool:weather_lookup',
        estimatedAffected: beforeWeather,
        reasoning: 'Drop the weather_lookup keyspace; provider rotated and cached values are stale.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      expect(approveRes.body.applied_result.details).toMatchObject({
        filter_kind: 'key_prefix',
        prefix: 'tool:weather_lookup',
      });

      expect(await countToolEntries(cacheValkey, cacheName, 'weather_lookup')).toBe(0);
      expect(await countToolEntries(cacheValkey, cacheName, 'classify_intent')).toBe(beforeOther);
    });
  });

  describe('expire flow', () => {
    const cacheName = 'e2e-expire';

    beforeAll(async () => {
      await prodAgentThreeTools.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('marks an overdue proposal as expired and writes an expired audit entry', async () => {
      const service = app.get(CacheProposalService);

      const proposeResult = await service.proposeToolTtlAdjust(connectionId, {
        cacheName,
        toolName: 'classify_intent',
        newTtlSeconds: 1200,
        reasoning: 'This proposal is going to be left to expire by the test.',
      });
      const proposalId = proposeResult.proposal.id;

      const farFuture = Date.now() + 100 * 24 * 60 * 60 * 1000;
      const expiredCount = await service.expireProposals(farFuture);
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const detailRes = await request(app.getHttpServer())
        .get(`/cache-proposals/${proposalId}`)
        .set('X-Connection-Id', connectionId)
        .expect(200);

      expect(detailRes.body.proposal.status).toBe('expired');
      const expiredAudit = (detailRes.body.audit as Array<{ event_type: string }>).find(
        (e) => e.event_type === 'expired',
      );
      expect(expiredAudit).toBeDefined();
    });
  });

  describe('estimated vs actual mismatch', () => {
    const cacheName = 'e2e-estimate-mismatch';
    const TARGET_TOOL = 'classify_intent';

    beforeAll(async () => {
      process.env.AGENT_INVALIDATE_PER_TOOL = '50';
      await agentInvalidateByTool.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('still applies when actual_affected is far above estimated_affected', async () => {
      const service = app.get(CacheProposalService);

      const proposeResult = await service.proposeInvalidate(connectionId, {
        cacheName,
        filterKind: 'tool',
        filterValue: TARGET_TOOL,
        estimatedAffected: 5,
        reasoning: 'Estimate intentionally low — test that apply still succeeds.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      const remaining = await countToolEntries(cacheValkey, cacheName, TARGET_TOOL);
      expect(remaining).toBe(0);
    });
  });

  describe('semantic_cache threshold_adjust (UI happy path)', () => {
    const cacheName = 'e2e-semantic-threshold';
    let runReal = false;

    beforeAll(async () => {
      runReal = await ollamaReachable();
      if (!runReal) {
        return;
      }
      process.env.FAQ_PER_TOPIC = '5';
      const embedFn = await createEmbedder();
      await faqCacheBimodal.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn,
      });
    }, 120_000);

    it('approves a threshold_adjust proposal and writes the new threshold to __config', async () => {
      if (!runReal) {
        // eslint-disable-next-line no-console
        console.warn('Ollama not reachable; skipping semantic threshold_adjust test.');
        return;
      }
      const service = app.get(CacheProposalService);

      const before = await cacheValkey.hget(`${cacheName}:__config`, 'threshold');
      expect(before).toBe('0.1');

      const proposeResult = await service.proposeThresholdAdjust(connectionId, {
        cacheName,
        newThreshold: 0.075,
        reasoning: 'Trough in similarity distribution near 0.08; tightening from 0.10 to 0.075.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      expect(approveRes.body.applied_result.details).toMatchObject({
        previous_value: 0.1,
        new_value: 0.075,
      });

      const after = await cacheValkey.hget(`${cacheName}:__config`, 'threshold');
      expect(after).toBe('0.075');
    });
  });

  describe('semantic_cache invalidate (filter_kind=valkey_search)', () => {
    const cacheName = 'e2e-semantic-invalidate';
    let runReal = false;

    beforeAll(async () => {
      runReal = await ollamaReachable();
      if (!runReal) {
        return;
      }
      process.env.SEMANTIC_INVALIDATE_TOTAL = '20';
      const embedFn = await createEmbedder();
      await semanticInvalidateByModel.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn,
      });
    }, 120_000);

    it('approves an invalidate proposal that drops only the matching model entries', async () => {
      if (!runReal) {
        // eslint-disable-next-line no-console
        console.warn('Ollama not reachable; skipping semantic invalidate test.');
        return;
      }
      const service = app.get(CacheProposalService);

      const beforeCount = (await listKeys(cacheValkey, `${cacheName}:entry:*`)).length;
      expect(beforeCount).toBe(20);

      const proposeResult = await service.proposeInvalidate(connectionId, {
        cacheName,
        filterKind: 'valkey_search',
        filterExpression: '@model:{gpt\\-4o\\-mini}',
        estimatedAffected: 12,
        reasoning: 'Dropping cached responses generated by the gpt-4o-mini model after a regression.',
      });

      const approveRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/approve`)
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(approveRes.status);
      expect(approveRes.body.status).toBe('applied');
      expect(approveRes.body.applied_result.success).toBe(true);

      const afterCount = (await listKeys(cacheValkey, `${cacheName}:entry:*`)).length;
      expect(afterCount).toBe(8);
    });
  });

  describe('edit-and-approve', () => {
    const cacheName = 'e2e-edit-and-approve';

    beforeAll(async () => {
      await prodAgentThreeTools.run({
        valkeyHost: VALKEY_BUNDLE_HOST,
        valkeyPort: VALKEY_BUNDLE_PORT,
        cacheName,
        embedFn: NOOP_EMBED,
      });
    });

    it('applies the edited TTL value, not the original proposal value', async () => {
      const service = app.get(CacheProposalService);

      const proposeResult = await service.proposeToolTtlAdjust(connectionId, {
        cacheName,
        toolName: 'classify_intent',
        newTtlSeconds: 600,
        reasoning: 'Initial proposal — operator may tighten this further.',
      });

      const editRes = await request(app.getHttpServer())
        .post(`/cache-proposals/${proposeResult.proposal.id}/edit-and-approve`)
        .send({ new_ttl_seconds: 900, actor: 'integration-test' })
        .set('X-Connection-Id', connectionId);
      expect([200, 201]).toContain(editRes.status);
      expect(editRes.body.status).toBe('applied');
      expect(editRes.body.applied_result.details).toMatchObject({
        tool_name: 'classify_intent',
        previous_value: 300,
        new_value: 900,
      });

      const policy = await readPolicy(cacheValkey, cacheName, 'classify_intent');
      expect(policy.ttl).toBe(900);
    });
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

async function countToolEntries(
  client: Redis,
  cacheName: string,
  toolName: string,
): Promise<number> {
  const pattern = `${cacheName}:tool:${toolName}:*`;
  return (await listKeys(client, pattern)).length;
}

async function countSessionKeys(
  client: Redis,
  cacheName: string,
  sessionId: string,
): Promise<number> {
  const pattern = `${cacheName}:session:${sessionId}*`;
  return (await listKeys(client, pattern)).length;
}

async function listKeys(client: Redis, pattern: string): Promise<string[]> {
  let cursor = '0';
  const out: string[] = [];
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}
