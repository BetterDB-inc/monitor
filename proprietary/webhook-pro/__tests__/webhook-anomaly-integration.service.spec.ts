import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookAnomalyIntegrationService } from '../webhook-anomaly-integration.service';
import { WebhookProService } from '../webhook-pro.service';
import { StoragePort, StoredAnomalyEvent } from '@app/common/interfaces/storage-port.interface';
import { incidentEventUrl } from '@betterdb/shared';

describe('WebhookAnomalyIntegrationService', () => {
  let service: WebhookAnomalyIntegrationService;
  let webhookProService: jest.Mocked<WebhookProService>;
  let storageClient: jest.Mocked<StoragePort>;
  let configService: jest.Mocked<ConfigService>;
  let frontendUrl: string | undefined;

  beforeEach(async () => {
    webhookProService = {
      dispatchAnomalyDetected: jest.fn(),
      dispatchAnomalySequenceDetected: jest.fn(),
      dispatchLatencySpike: jest.fn(),
      dispatchConnectionSpike: jest.fn(),
    } as any;

    storageClient = {
      getAnomalyEvents: jest.fn(),
    } as any;

    frontendUrl = undefined;
    configService = {
      get: jest.fn((key: string, defaultValue: any) => {
        if (key === 'FRONTEND_URL') return frontendUrl;
        if (key === 'database.host') return 'localhost';
        if (key === 'database.port') return 6379;
        return defaultValue;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookAnomalyIntegrationService,
        {
          provide: WebhookProService,
          useValue: webhookProService,
        },
        {
          provide: 'STORAGE_CLIENT',
          useValue: storageClient,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<WebhookAnomalyIntegrationService>(WebhookAnomalyIntegrationService);
  });

  describe('connection.spike webhook dispatch', () => {
    it('should dispatch connection.spike for connections spike anomaly', async () => {
      const anomaly: StoredAnomalyEvent = {
        id: '123',
        timestamp: Date.now(),
        metricType: 'connections',
        anomalyType: 'spike',
        severity: 'warning',
        value: 150,
        baseline: 50,
        stdDev: 20,
        zScore: 5.0,
        threshold: 3.0,
        message: 'Connection spike detected',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          metricType: 'connections',
          anomalyType: 'spike',
          value: 150,
        })
      );

      expect(webhookProService.dispatchConnectionSpike).toHaveBeenCalledWith({
        currentConnections: 150,
        baseline: 50,
        threshold: 3.0,
        timestamp: anomaly.timestamp,
        instance: { host: 'localhost', port: 6379 },
      });
    });

    it('should NOT dispatch connection.spike for connections drop anomaly', async () => {
      const anomaly: StoredAnomalyEvent = {
        id: '123',
        timestamp: Date.now(),
        metricType: 'connections',
        anomalyType: 'drop',
        severity: 'warning',
        value: 10,
        baseline: 50,
        stdDev: 20,
        zScore: -2.0,
        threshold: 3.0,
        message: 'Connection drop detected',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalled();
      expect(webhookProService.dispatchConnectionSpike).not.toHaveBeenCalled();
    });
  });

  describe('latency.spike webhook dispatch', () => {
    it('should dispatch latency.spike for ops_per_sec drop anomaly', async () => {
      const anomaly: StoredAnomalyEvent = {
        id: '456',
        timestamp: Date.now(),
        metricType: 'ops_per_sec',
        anomalyType: 'drop',
        severity: 'critical',
        value: 100,
        baseline: 1000,
        stdDev: 200,
        zScore: -4.5,
        threshold: 3.0,
        message: 'Operations per second dropped',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          metricType: 'ops_per_sec',
          anomalyType: 'drop',
          value: 100,
        })
      );

      expect(webhookProService.dispatchLatencySpike).toHaveBeenCalledWith({
        currentLatency: 10, // 1000 / 100
        baseline: 1.0,
        threshold: 3.0,
        timestamp: anomaly.timestamp,
        instance: { host: 'localhost', port: 6379 },
      });
    });

    it('should NOT dispatch latency.spike for ops_per_sec spike anomaly', async () => {
      const anomaly: StoredAnomalyEvent = {
        id: '456',
        timestamp: Date.now(),
        metricType: 'ops_per_sec',
        anomalyType: 'spike',
        severity: 'info',
        value: 2000,
        baseline: 1000,
        stdDev: 200,
        zScore: 5.0,
        threshold: 3.0,
        message: 'Operations per second spiked (good)',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalled();
      expect(webhookProService.dispatchLatencySpike).not.toHaveBeenCalled();
    });

    it('should handle zero value in latency calculation', async () => {
      const anomaly: StoredAnomalyEvent = {
        id: '456',
        timestamp: Date.now(),
        metricType: 'ops_per_sec',
        anomalyType: 'drop',
        severity: 'critical',
        value: 0,
        baseline: 1000,
        stdDev: 200,
        zScore: -5.0,
        threshold: 3.0,
        message: 'Operations stopped',
        resolved: false,
        sourceHost: 'localhost',
        sourcePort: 6379,
      };

      await service.dispatchAnomalyWebhook(anomaly);

      // When value is 0, baseline/0 = Infinity
      expect(webhookProService.dispatchLatencySpike).toHaveBeenCalledWith({
        currentLatency: Infinity,
        baseline: 1.0,
        threshold: 3.0,
        timestamp: anomaly.timestamp,
        instance: { host: 'localhost', port: 6379 },
      });
    });
  });

  describe('multiple anomalies', () => {
    it('should dispatch both connection.spike and anomaly.detected for multiple anomalies', async () => {
      const anomalies: StoredAnomalyEvent[] = [
        {
          id: '1',
          timestamp: Date.now(),
          metricType: 'connections',
          anomalyType: 'spike',
          severity: 'warning',
          value: 150,
          baseline: 50,
          stdDev: 20,
          zScore: 5.0,
          threshold: 3.0,
          message: 'Connection spike',
          resolved: false,
          sourceHost: 'localhost',
          sourcePort: 6379,
        },
        {
          id: '2',
          timestamp: Date.now(),
          metricType: 'ops_per_sec',
          anomalyType: 'drop',
          severity: 'critical',
          value: 100,
          baseline: 1000,
          stdDev: 200,
          zScore: -4.5,
          threshold: 3.0,
          message: 'Latency spike',
          resolved: false,
          sourceHost: 'localhost',
          sourcePort: 6379,
        },
      ];

      for (const anomaly of anomalies) await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalledTimes(2);
      expect(webhookProService.dispatchConnectionSpike).toHaveBeenCalledTimes(1);
      expect(webhookProService.dispatchLatencySpike).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should continue processing if webhook dispatch fails', async () => {
      const anomalies: StoredAnomalyEvent[] = [
        {
          id: '1',
          timestamp: Date.now(),
          metricType: 'connections',
          anomalyType: 'spike',
          severity: 'warning',
          value: 150,
          baseline: 50,
          stdDev: 20,
          zScore: 5.0,
          threshold: 3.0,
          message: 'Connection spike',
          resolved: false,
          sourceHost: 'localhost',
          sourcePort: 6379,
        },
      ];

      webhookProService.dispatchAnomalyDetected.mockRejectedValue(new Error('Webhook error'));

      await expect(service.dispatchAnomalyWebhook(anomalies[0])).resolves.not.toThrow();
    });
  });

  describe('sequence alert', () => {
    const event = (id: string, timestamp: number, metricType: string, connectionId?: string) =>
      ({ id, timestamp, metricType, connectionId }) as any;
    const group = (overrides: Record<string, unknown> = {}) =>
      ({
        correlationId: 'grp-1',
        timestamp: 1000,
        anomalies: [
          event('a', 1000, 'connections', 'conn-1'),
          event('b', 2000, 'memory_used', 'conn-2'),
        ],
        pattern: 'memory_pressure',
        severity: 'critical',
        diagnosis: 'Connections led to memory growth',
        recommendations: ['Check clients'],
        ...overrides,
      }) as any;

    it('sends one alert under the connection of the first event', async () => {
      await service.dispatchSequenceWebhook(group());

      expect(webhookProService.dispatchAnomalySequenceDetected).toHaveBeenCalledTimes(1);
      expect(webhookProService.dispatchAnomalySequenceDetected.mock.calls[0][0]).toStrictEqual({
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
      });
    });

    it('adds the incident link when the frontend URL is set', async () => {
      frontendUrl = 'https://m.example.com/';

      await service.dispatchSequenceWebhook(group());

      expect(webhookProService.dispatchAnomalySequenceDetected.mock.calls[0][0].incidentUrl).toBe(
        'https://m.example.com/anomalies/incidents/by-event/a?at=1000&connection=conn-1',
      );
    });

    it('carries the recommendation values of the match', async () => {
      const values = [{ setting: 'repl-backlog-size', current: 1, target: 64, unit: 'MB' }];

      await service.dispatchSequenceWebhook(group({ values }));

      expect(webhookProService.dispatchAnomalySequenceDetected.mock.calls[0][0].values).toEqual(
        values,
      );
    });

    it('sends nothing for a group whose first event has no connection', async () => {
      await service.dispatchSequenceWebhook(group({ anomalies: [event('a', 1000, 'connections')] }));
      await service.dispatchSequenceWebhook(group({ anomalies: [] }));

      expect(webhookProService.dispatchAnomalySequenceDetected).not.toHaveBeenCalled();
    });

    it('does not reject when the dispatch fails', async () => {
      webhookProService.dispatchAnomalySequenceDetected.mockRejectedValue(new Error('down'));

      await expect(service.dispatchSequenceWebhook(group())).resolves.toBeUndefined();
    });
  });

  describe('incident link on anomaly.detected', () => {
    const anomaly: StoredAnomalyEvent = {
      id: 'ev-1',
      timestamp: 1706457000000,
      metricType: 'memory_used',
      anomalyType: 'spike',
      severity: 'warning',
      value: 2,
      baseline: 1,
      stdDev: 0.1,
      zScore: 5,
      threshold: 3,
      message: 'Memory spike',
      resolved: false,
      connectionId: 'conn-1',
    };

    it('adds the incident link when the frontend URL is set', async () => {
      frontendUrl = 'https://m.example.com';

      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected.mock.calls[0][0]).toHaveProperty(
        'incidentUrl',
        incidentEventUrl('https://m.example.com', 'ev-1', 1706457000000, 'conn-1'),
      );
    });

    it('leaves the incident link off without a frontend URL', async () => {
      await service.dispatchAnomalyWebhook(anomaly);

      expect(webhookProService.dispatchAnomalyDetected.mock.calls[0][0]).not.toHaveProperty(
        'incidentUrl',
      );
    });
  });
});
