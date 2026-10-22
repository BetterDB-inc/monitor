import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType, type KvCacheEvictionRiskData, type KvCacheHitRateLowData } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - KV cache events', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchThresholdAlert: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const hitRateData: KvCacheHitRateLowData = {
    connectionId: 'conn-1',
    engineId: 'eng-1',
    engineName: 'vllm-a',
    model: 'llama',
    hitRate: 0.1,
    threshold: 0.2,
    requestedTokens: 20000,
    windowMs: 900000,
    timestamp: 123,
  };

  const evictionData: KvCacheEvictionRiskData = {
    connectionId: 'conn-1',
    reason: 'unevictable',
    active: true,
    policy: 'volatile-lru',
    usedMemory: 90,
    maxmemory: 100,
    lmcacheMemoryShare: 0.8,
    noTtlRatio: 0.95,
    evictedKeysDelta: 0,
    timestamp: 123,
  };

  beforeEach(async () => {
    webhookDispatcher = { dispatchThresholdAlert: jest.fn().mockResolvedValue(undefined) };
    licenseService = { getLicenseTier: jest.fn().mockReturnValue('pro') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsProService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: licenseService },
      ],
    }).compile();
    service = module.get(WebhookEventsProService);
  });

  it('dispatches a below-threshold hit rate alert keyed per engine and model', async () => {
    await service.dispatchKvCacheHitRateLow(hitRateData);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledWith(
      WebhookEventType.KV_CACHE_HIT_RATE_LOW,
      'kv_cache_hit_rate_low:eng-1:llama',
      0.1,
      0.2,
      false,
      expect.objectContaining({
        ...hitRateData,
        message: 'LMCache hit rate for llama on vllm-a is 10.0% (threshold 20.0%)',
      }),
      'conn-1',
    );
  });

  it('dispatches an active unevictable alert with value 1', async () => {
    await service.dispatchKvCacheEvictionRisk(evictionData);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledWith(
      WebhookEventType.KV_CACHE_EVICTION_RISK,
      'kv_cache_eviction_risk:conn-1:unevictable',
      1,
      1,
      true,
      expect.objectContaining({
        ...evictionData,
        message: 'LMCache keys have no TTL under volatile-lru; Valkey cannot evict them',
      }),
      'conn-1',
    );
  });

  it('dispatches an inactive evicting alert with value 0', async () => {
    await service.dispatchKvCacheEvictionRisk({ ...evictionData, reason: 'evicting', active: false });
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledWith(
      WebhookEventType.KV_CACHE_EVICTION_RISK,
      'kv_cache_eviction_risk:conn-1:evicting',
      0,
      1,
      true,
      expect.objectContaining({ message: 'Valkey is evicting keys while LMCache holds most of its memory' }),
      'conn-1',
    );
  });

  it('skips both events without a license', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');
    await service.dispatchKvCacheHitRateLow(hitRateData);
    await service.dispatchKvCacheEvictionRisk(evictionData);
    expect(webhookDispatcher.dispatchThresholdAlert).not.toHaveBeenCalled();
  });
});
