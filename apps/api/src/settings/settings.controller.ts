import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Body,
  HttpCode,
  UsePipes,
  ValidationPipe,
  Inject,
  Optional,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiOkResponse } from '@nestjs/swagger';
import { SettingsUpdateRequest, SettingsResponse } from '@betterdb/shared';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import type { IAnomalyService } from '@betterdb/shared';
import {
  API_METRIC_TYPES,
  DETECTOR_DEFAULTS,
  DetectorConfig,
  DetectorConfigMap,
  MetricType,
  resolveDetectorConfig,
  toApiDetectorConfig,
} from '../anomaly/anomaly.types';
import { UpdateAnomalyDetectorsDto, DetectorConfigDto } from './dto/update-anomaly-detectors.dto';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController implements OnModuleInit {
  private readonly logger = new Logger(SettingsController.name);

  constructor(
    private readonly settingsService: SettingsService,
    private readonly prometheusService: PrometheusService,
    @Optional() @Inject(ANOMALY_SERVICE) private readonly anomalyService?: IAnomalyService,
  ) {}

  onModuleInit(): void {
    if (!this.anomalyService) {
      this.logger.warn(
        'AnomalyService not injected into SettingsController — ' +
          'detector config hot-reload will be skipped on PATCH',
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get current application settings' })
  @ApiResponse({ status: 200, description: 'Returns current settings with source information' })
  async getSettings(): Promise<SettingsResponse> {
    return this.settingsService.getSettings();
  }

  @Put()
  @ApiOperation({ summary: 'Update application settings' })
  @ApiResponse({ status: 200, description: 'Settings updated successfully' })
  async updateSettings(@Body() updates: SettingsUpdateRequest): Promise<SettingsResponse> {
    return this.settingsService.updateSettings(updates);
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset settings to defaults from environment variables' })
  @ApiResponse({ status: 200, description: 'Settings reset to defaults' })
  async resetSettings(): Promise<SettingsResponse> {
    return this.settingsService.resetToDefaults();
  }

  @Get('anomaly/detectors')
  @ApiOperation({ summary: 'Get anomaly detector threshold configuration' })
  @ApiOkResponse()
  async getAnomalyDetectors(): Promise<{
    defaults: Record<MetricType, DetectorConfig>;
    overrides: DetectorConfigMap;
    resolved: Record<MetricType, DetectorConfig>;
  }> {
    const overrides = await this.settingsService.getDetectorConfig();

    const sanitize = (cfg: Required<DetectorConfig>) => toApiDetectorConfig(cfg);

    const defaults = Object.fromEntries(
      API_METRIC_TYPES.map((m) => [m, sanitize(DETECTOR_DEFAULTS[m])]),
    ) as Record<MetricType, DetectorConfig>;

    const resolved = Object.fromEntries(
      API_METRIC_TYPES.map((m) => [m, sanitize(resolveDetectorConfig(m, overrides))]),
    ) as Record<MetricType, DetectorConfig>;

    return { defaults, overrides, resolved };
  }

  @Patch('anomaly/detectors')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update per-metric anomaly detector thresholds' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async patchAnomalyDetectors(
    @Body() dto: UpdateAnomalyDetectorsDto,
  ): Promise<{ message: string; config: DetectorConfigMap }> {
    const configMap = this.dtoToConfigMap(dto);
    const result = await this.settingsService.updateDetectorConfig(configMap);
    this.anomalyService?.reloadDetectorConfig(result);
    this.prometheusService.incrementDetectorConfigUpdates();
    return { message: 'Detector config updated', config: result };
  }

  @Post('anomaly/detectors/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset all anomaly detector thresholds to defaults' })
  async resetAnomalyDetectors(): Promise<{ message: string }> {
    await this.settingsService.updateSettings({ anomalyDetectorConfig: {} });
    this.anomalyService?.reloadDetectorConfig({});
    return { message: 'Detector config reset to defaults' };
  }

  private dtoToConfigMap(dto: UpdateAnomalyDetectorsDto): DetectorConfigMap {
    const map: DetectorConfigMap = {};
    for (const metric of API_METRIC_TYPES) {
      const entry = dto[metric];
      if (entry !== undefined) {
        map[metric] = this.stripUndefined(entry);
      }
    }
    return map;
  }

  private stripUndefined(dto: DetectorConfigDto): DetectorConfigMap[MetricType] {
    const out: DetectorConfigMap[MetricType] = {};
    if (dto.warningZScore !== undefined) out.warningZScore = dto.warningZScore;
    if (dto.criticalZScore !== undefined) out.criticalZScore = dto.criticalZScore;
    if (dto.warningAbsolute !== undefined) out.warningAbsolute = dto.warningAbsolute;
    if (dto.criticalAbsolute !== undefined) out.criticalAbsolute = dto.criticalAbsolute;
    if (dto.consecutiveRequired !== undefined) out.consecutiveRequired = dto.consecutiveRequired;
    if (dto.cooldownMs !== undefined) out.cooldownMs = dto.cooldownMs;
    return out;
  }
}
