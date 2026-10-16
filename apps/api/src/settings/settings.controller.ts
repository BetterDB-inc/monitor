import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  BadRequestException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiOkResponse } from '@nestjs/swagger';
import { SettingsUpdateRequest, SettingsResponse } from '@betterdb/shared';
import { LicenseGuard, RequiresFeature, Feature } from '@proprietary/licenses';
import {
  API_METRIC_TYPES,
  DETECTOR_DEFAULTS,
  DetectorConfig,
  DetectorConfigMap,
  MetricType,
  resolveDetectorConfig,
  sanitizeStoredOverride,
  toApiDetectorConfig,
} from '../anomaly/anomaly.types';
import { UpdateAnomalyDetectorsDto, DetectorConfigDto } from './dto/update-anomaly-detectors.dto';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly prometheusService: PrometheusService,
  ) {}

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
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
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

    const sanitizedOverrides = Object.fromEntries(
      (Object.keys(overrides) as MetricType[]).map((m) => [
        m,
        sanitizeStoredOverride(overrides[m] ?? {}),
      ]),
    ) as DetectorConfigMap;

    return { defaults, overrides: sanitizedOverrides, resolved };
  }

  @Patch('anomaly/detectors')
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @HttpCode(200)
  @ApiOperation({ summary: 'Update per-metric anomaly detector thresholds' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async patchAnomalyDetectors(
    @Body() dto: UpdateAnomalyDetectorsDto,
  ): Promise<{ message: string; config: DetectorConfigMap }> {
    const configMap = this.dtoToConfigMap(dto);
    const result = await this.settingsService.updateDetectorConfig(configMap);
    this.prometheusService.incrementDetectorConfigUpdates();

    // Sanitize before returning: strip Infinity sentinels from stored
    // overrides so the JSON response never contains null absolute fields.
    return { message: 'Detector config updated', config: this.sanitizeMap(result) };
  }

  @Delete('anomaly/detectors/:metric')
  @HttpCode(200)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Clear the threshold override for one metric' })
  async deleteAnomalyDetector(
    @Param('metric') metric: string,
  ): Promise<{ message: string; config: DetectorConfigMap }> {
    if (!(API_METRIC_TYPES as readonly string[]).includes(metric)) {
      throw new BadRequestException(
        `Unknown metric "${metric}". Expected one of: ${API_METRIC_TYPES.join(', ')}`,
      );
    }
    const result = await this.settingsService.clearDetectorOverride(metric as MetricType);
    this.prometheusService.incrementDetectorConfigUpdates();
    return { message: `Detector override cleared for ${metric}`, config: this.sanitizeMap(result) };
  }

  @Post('anomaly/detectors/reset')
  @HttpCode(200)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Reset all anomaly detector thresholds to defaults' })
  async resetAnomalyDetectors(): Promise<{ message: string }> {
    await this.settingsService.resetDetectorConfig();
    this.prometheusService.incrementDetectorConfigUpdates();
    return { message: 'Detector config reset to defaults' };
  }

  private sanitizeMap(map: DetectorConfigMap): DetectorConfigMap {
    const out: DetectorConfigMap = {};
    for (const key of Object.keys(map) as MetricType[]) {
      out[key] = sanitizeStoredOverride(map[key] ?? {});
    }
    return out;
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
