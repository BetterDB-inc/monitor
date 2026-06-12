/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import {
  API_METRIC_TYPES,
  DETECTOR_DEFAULTS,
  MetricType,
  resolveDetectorConfig,
  toApiDetectorConfig,
} from '../anomaly/anomaly.types';
import { UpdateAnomalyDetectorsDto } from './dto/update-anomaly-detectors.dto';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

describe('Settings anomaly detector thresholds', () => {
  let controller: SettingsController;
  let settingsService: {
    getDetectorConfig: jest.Mock;
    updateDetectorConfig: jest.Mock;
    updateSettings: jest.Mock;
  };
  let anomalyService: { reloadDetectorConfig: jest.Mock };
  let prometheusService: { incrementDetectorConfigUpdates: jest.Mock };

  beforeEach(async () => {
    settingsService = {
      getDetectorConfig: jest.fn().mockResolvedValue({}),
      updateDetectorConfig: jest.fn().mockImplementation(async (map) => map),
      updateSettings: jest.fn().mockResolvedValue({
        settings: { anomalyDetectorConfig: {} },
        source: 'database',
        requiresRestart: false,
      }),
    };
    anomalyService = { reloadDetectorConfig: jest.fn() };
    prometheusService = { incrementDetectorConfigUpdates: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SettingsService, useValue: settingsService },
        { provide: PrometheusService, useValue: prometheusService },
        { provide: ANOMALY_SERVICE, useValue: anomalyService },
      ],
    }).compile();

    controller = module.get(SettingsController);
  });

  describe('GET /settings/anomaly/detectors', () => {
    it('returns defaults when no overrides are stored', async () => {
      const result = await controller.getAnomalyDetectors();
      expect(result.overrides).toEqual({});
      for (const metric of API_METRIC_TYPES) {
        expect(result.resolved[metric]).toEqual(toApiDetectorConfig(DETECTOR_DEFAULTS[metric]));
      }
    });

    it('GET response omits Infinity absolute fields, includes real ones', async () => {
      const result = await controller.getAnomalyDetectors();
      // connections has no absolute threshold — fields should be absent
      expect('warningAbsolute' in result.defaults.connections).toBe(false);
      expect('criticalAbsolute' in result.defaults.connections).toBe(false);
      // acl_denied has real absolute thresholds — fields should be present
      expect(result.defaults.acl_denied.warningAbsolute).toBe(10);
      expect(result.defaults.acl_denied.criticalAbsolute).toBe(50);
    });

    it('merges stored overrides with defaults per field', async () => {
      settingsService.getDetectorConfig.mockResolvedValue({
        [MetricType.connections]: { warningZScore: 2.5 },
      });
      const result = await controller.getAnomalyDetectors();
      expect(result.resolved.connections.warningZScore).toBe(2.5);
      expect(result.resolved.connections.criticalZScore).toBe(
        DETECTOR_DEFAULTS[MetricType.connections].criticalZScore,
      );
      expect(result.resolved.memory_used).toEqual(
        toApiDetectorConfig(DETECTOR_DEFAULTS[MetricType.memory_used]),
      );
    });
  });

  describe('PATCH /settings/anomaly/detectors', () => {
    const validationPipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });

    it('persists partial updates and hot-reloads', async () => {
      const merged = { [MetricType.connections]: { warningZScore: 2.5, consecutiveRequired: 5 } };
      settingsService.updateDetectorConfig.mockResolvedValue(merged);

      const result = await controller.patchAnomalyDetectors({
        connections: { warningZScore: 2.5, consecutiveRequired: 5 },
      });

      expect(result).toEqual({ message: 'Detector config updated', config: merged });
      expect(settingsService.updateDetectorConfig).toHaveBeenCalledWith({
        connections: { warningZScore: 2.5, consecutiveRequired: 5 },
      });
      expect(anomalyService.reloadDetectorConfig).toHaveBeenCalledWith(merged);
      expect(prometheusService.incrementDetectorConfigUpdates).toHaveBeenCalled();
    });

    it('rejects invalid warningZScore', async () => {
      await expect(
        validationPipe.transform(
          { connections: { warningZScore: -1 } },
          { type: 'body', metatype: UpdateAnomalyDetectorsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown metric keys', async () => {
      await expect(
        validationPipe.transform(
          { fake_metric: { warningZScore: 2.5 } },
          { type: 'body', metatype: UpdateAnomalyDetectorsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects warningZScore greater than or equal to criticalZScore', async () => {
      await expect(
        validationPipe.transform(
          { connections: { warningZScore: 5, criticalZScore: 2 } },
          { type: 'body', metatype: UpdateAnomalyDetectorsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects partial PATCH that inverts Z-scores against stored config', async () => {
      settingsService.updateDetectorConfig.mockRejectedValue(
        new BadRequestException(
          'connections: warningZScore (9.5) must be less than criticalZScore (3.0)',
        ),
      );
      await expect(
        controller.patchAnomalyDetectors({ connections: { warningZScore: 9.5 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects warningAbsolute >= criticalAbsolute in same payload', async () => {
      await expect(
        validationPipe.transform(
          { acl_denied: { warningAbsolute: 100, criticalAbsolute: 10 } },
          { type: 'body', metatype: UpdateAnomalyDetectorsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('POST /settings/anomaly/detectors/reset', () => {
    it('clears stored overrides and hot-reloads empty config', async () => {
      const result = await controller.resetAnomalyDetectors();

      expect(result).toEqual({ message: 'Detector config reset to defaults' });
      expect(settingsService.updateSettings).toHaveBeenCalledWith({ anomalyDetectorConfig: {} });
      expect(anomalyService.reloadDetectorConfig).toHaveBeenCalledWith({});
    });
  });

  describe('SettingsService.updateDetectorConfig field merge', () => {
    it('merges at field level within a metric', async () => {
      const storageClient = {
        getSettings: jest.fn().mockResolvedValue({
          id: 1,
          auditPollIntervalMs: 60000,
          clientAnalyticsPollIntervalMs: 60000,
          anomalyPollIntervalMs: 1000,
          anomalyCacheTtlMs: 3600000,
          anomalyPrometheusIntervalMs: 30000,
          metricForecastingEnabled: true,
          metricForecastingDefaultRollingWindowMs: 21600000,
          metricForecastingDefaultAlertThresholdMs: 7200000,
          inferenceSlaConfig: {},
          anomalyDetectorConfig: {
            connections: { warningZScore: 2.5, consecutiveRequired: 5 },
          },
          createdAt: 1,
          updatedAt: 1,
        }),
        updateSettings: jest.fn().mockImplementation(async (updates) => ({
          ...(await storageClient.getSettings()),
          ...updates,
          anomalyDetectorConfig: updates.anomalyDetectorConfig,
        })),
        saveSettings: jest.fn(),
      };

      const configService = {
        get: jest.fn((_key: string, defaultValue: string) => defaultValue),
      };

      const svc = new SettingsService(storageClient as any, configService as any);
      svc['cachedSettings'] = await storageClient.getSettings();

      const result = await svc.updateDetectorConfig({
        connections: { warningZScore: 2.8 },
      });

      expect(result.connections).toEqual({
        warningZScore: 2.8,
        consecutiveRequired: 5,
      });
    });
  });

  describe('resolveDetectorConfig', () => {
    it('field-level merge matches service expectations', () => {
      const existing = { connections: { warningZScore: 2.5, consecutiveRequired: 5 } };
      const merged = {
        connections: { ...existing.connections, warningZScore: 2.8 },
      };
      expect(resolveDetectorConfig(MetricType.connections, merged).warningZScore).toBe(2.8);
      expect(resolveDetectorConfig(MetricType.connections, merged).consecutiveRequired).toBe(5);
    });
  });
});
