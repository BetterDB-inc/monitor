import { PRO_EVENTS, Tier, WebhookEventType, getRequiredTierForEvent } from '@betterdb/shared';
import { WebhookProService, type AnomalySequenceAlert } from '../webhook-pro.service';

describe('anomaly.sequence.detected', () => {
  const alert: AnomalySequenceAlert = {
    correlationId: 'grp-1',
    pattern: 'memory_pressure',
    severity: 'critical',
    diagnosis: 'Connections led to memory growth',
    recommendations: ['Check clients'],
    anomalyIds: ['a', 'b'],
    metricTypes: ['connections', 'memory_used'],
    anomalyId: 'a',
    timestamp: 1000,
    message: 'Memory pressure: Connections led to memory growth',
    connectionId: 'conn-1',
  };

  it('is a Pro event', () => {
    expect(getRequiredTierForEvent(WebhookEventType.ANOMALY_SEQUENCE_DETECTED)).toBe(Tier.pro);
    expect(PRO_EVENTS).toContain(WebhookEventType.ANOMALY_SEQUENCE_DETECTED);
  });

  it('dispatches the alert under its connection', async () => {
    const dispatcher = { dispatchEvent: jest.fn().mockResolvedValue(true) };
    const service = new WebhookProService(dispatcher as any);
    const { connectionId, ...data } = alert;

    await service.dispatchAnomalySequenceDetected(alert);

    expect(dispatcher.dispatchEvent).toHaveBeenCalledWith(
      WebhookEventType.ANOMALY_SEQUENCE_DETECTED,
      data,
      connectionId,
    );
  });
});
