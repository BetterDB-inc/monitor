import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType, type ServedClusterNodeRef } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - failing node on dedicated webhooks', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchEvent: jest.Mock };

  const node: ServedClusterNodeRef = {
    nodeId: 'primA',
    address: '10.0.0.1:6379',
    role: 'primary',
    shardId: 'shard-1',
    collected: true,
    connectionId: 'conn-1',
  };
  const common = {
    message: 'm',
    timestamp: 1_700_000_000_000,
    instance: { host: '10.0.0.1', port: 6379 },
    connectionId: 'conn-1',
  };
  const roleChange = { ...common, previousRole: 'master', newRole: 'replica' };

  const cases: Array<[WebhookEventType, (extra: { node?: ServedClusterNodeRef }) => Promise<void>]> = [
    [WebhookEventType.FAILOVER_STARTED, (extra) => service.dispatchFailoverStarted({ ...roleChange, ...extra })],
    [WebhookEventType.FAILOVER_COMPLETED, (extra) => service.dispatchFailoverCompleted({ ...roleChange, ...extra })],
    [
      WebhookEventType.DATA_LOSS_DETECTED,
      (extra) =>
        service.dispatchDataLossDetected({
          ...common,
          kind: 'primary_restarted_empty',
          previousKeys: 10,
          currentKeys: 0,
          previousReplid: 'a',
          newReplid: 'b',
          connectedSlaves: 1,
          role: 'master',
          ...extra,
        }),
    ],
    [
      WebhookEventType.RETRY_AMPLIFICATION_DETECTED,
      (extra) =>
        service.dispatchRetryAmplificationDetected({
          ...common,
          level: 'warning',
          trigger: 'latency',
          windows: 3,
          loadRatio: 1.5,
          pattern: 'rising',
          correlation: null,
          topContributors: null,
          ...extra,
        }),
    ],
    [
      WebhookEventType.REPLICATION_DIVERGENCE,
      (extra) =>
        service.dispatchReplicationDivergence({
          ...common,
          replica: '10.0.0.2:6380',
          level: 'warning',
          reason: 'growth',
          gapBytes: 1,
          secondsBehind: null,
          bytesPerSec: null,
          slopeBytesPerWindow: 1,
          windowCount: 3,
          correlatedSignals: [],
          replicaView: null,
          ...extra,
        }),
    ],
    [
      WebhookEventType.REPLICATION_RECOVERED,
      (extra) =>
        service.dispatchReplicationRecovered({
          ...common,
          replica: '10.0.0.2:6380',
          reason: 'caught_up',
          gapBytes: 0,
          ...extra,
        }),
    ],
  ];

  beforeEach(async () => {
    webhookDispatcher = { dispatchEvent: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsProService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: { getLicenseTier: jest.fn().mockReturnValue('pro') } },
      ],
    }).compile();
    service = module.get(WebhookEventsProService);
  });

  it.each(cases)('%s carries the node it is given', async (eventType, dispatch) => {
    await dispatch({ node });

    const [sentType, payload] = webhookDispatcher.dispatchEvent.mock.calls[0];
    expect(sentType).toBe(eventType);
    expect(payload.node).toEqual(node);
  });

  it.each(cases)('%s carries no node when none is given', async (_eventType, dispatch) => {
    await dispatch({});

    expect(webhookDispatcher.dispatchEvent.mock.calls[0][1]).not.toHaveProperty('node');
  });
});
