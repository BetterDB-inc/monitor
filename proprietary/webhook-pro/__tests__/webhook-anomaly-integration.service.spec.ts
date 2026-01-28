import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookAnomalyIntegrationService } from '../webhook-anomaly-integration.service';
import { WebhookProService } from '../webhook-pro.service';
import { StoragePort, StoredAnomalyEvent } from '@app/common/interfaces/storage-port.interface';

describe('WebhookAnomalyIntegrationService', () => {
  let service: WebhookAnomalyIntegrationService;
  let webhookProService: jest.Mocked<WebhookProService>;
  let storageClient: jest.Mocked<StoragePort>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    webhookProService = {
      dispatchAnomalyDetected: jest.fn(),
      dispatchLatencySpike: jest.fn(),
      dispatchConnectionSpike: jest.fn(),
    } as any;

    storageClient = {
      getAnomalyEvents: jest.fn(),
    } as any;

    configService = {
      get: jest.fn((key: string, defaultValue: any) => {
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

      storageClient.getAnomalyEvents.mockResolvedValue([anomaly]);

      // Trigger the polling check
      await (service as any).checkForNewAnomalies();

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

      storageClient.getAnomalyEvents.mockResolvedValue([anomaly]);

      await (service as any).checkForNewAnomalies();

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

      storageClient.getAnomalyEvents.mockResolvedValue([anomaly]);

      await (service as any).checkForNewAnomalies();

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

      storageClient.getAnomalyEvents.mockResolvedValue([anomaly]);

      await (service as any).checkForNewAnomalies();

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

      storageClient.getAnomalyEvents.mockResolvedValue([anomaly]);

      await (service as any).checkForNewAnomalies();

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

      storageClient.getAnomalyEvents.mockResolvedValue(anomalies);

      await (service as any).checkForNewAnomalies();

      expect(webhookProService.dispatchAnomalyDetected).toHaveBeenCalledTimes(2);
      expect(webhookProService.dispatchConnectionSpike).toHaveBeenCalledTimes(1);
      expect(webhookProService.dispatchLatencySpike).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should handle storage errors gracefully', async () => {
      storageClient.getAnomalyEvents.mockRejectedValue(new Error('Storage error'));

      await expect((service as any).checkForNewAnomalies()).resolves.not.toThrow();

      expect(webhookProService.dispatchAnomalyDetected).not.toHaveBeenCalled();
    });

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

      storageClient.getAnomalyEvents.mockResolvedValue(anomalies);
      webhookProService.dispatchAnomalyDetected.mockRejectedValue(new Error('Webhook error'));

      await expect((service as any).checkForNewAnomalies()).resolves.not.toThrow();
    });
  });
});
