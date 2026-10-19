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
import {
  SettingsUpdateRequest,
  SettingsResponse,
  AnomalyDetectorSettingsResponse,
  AnomalyDetectorUpdateResponse,
} from '@betterdb/shared';
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
  async getAnomalyDetectors(): Promise<AnomalyDetectorSettingsResponse> {
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
  ): Promise<AnomalyDetectorUpdateResponse> {
    const configMap = this.dtoToConfigMap(dto);
    const { config, changed } = await this.settingsService.updateDetectorConfig(configMap);
    if (changed) this.prometheusService.incrementDetectorConfigUpdates();

    // Sanitize before returning: strip Infinity sentinels from stored
    // overrides so the JSON response never contains null absolute fields.
    return {
      message: changed ? 'Detector config updated' : 'No changes',
      config: this.sanitizeMap(config),
    };
  }

  @Delete('anomaly/detectors/:metric')
  @HttpCode(200)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Clear the threshold override for one metric' })
  async deleteAnomalyDetector(
    @Param('metric') metric: string,
  ): Promise<AnomalyDetectorUpdateResponse> {
    if (!(API_METRIC_TYPES as readonly string[]).includes(metric)) {
      throw new BadRequestException(
        `Unknown metric "${metric}". Expected one of: ${API_METRIC_TYPES.join(', ')}`,
      );
    }
    const { config, changed } = await this.settingsService.clearDetectorOverride(
      metric as MetricType,
    );
    if (changed) this.prometheusService.incrementDetectorConfigUpdates();
    return {
      message: changed
        ? `Detector override cleared for ${metric}`
        : `No override to clear for ${metric}`,
      config: this.sanitizeMap(config),
    };
  }

  @Post('anomaly/detectors/reset')
  @HttpCode(200)
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.ANOMALY_DETECTION)
  @ApiOperation({ summary: 'Reset all anomaly detector thresholds to defaults' })
  async resetAnomalyDetectors(): Promise<{ message: string }> {
    const { changed } = await this.settingsService.resetDetectorConfig();
    if (changed) this.prometheusService.incrementDetectorConfigUpdates();
    return {
      message: changed
        ? 'Detector config reset to defaults'
        : 'Detector config already at defaults',
    };
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
      if (entry == null || typeof entry !== 'object') continue;
      const stripped = this.stripUndefined(entry);
      if (Object.keys(stripped).length > 0) map[metric] = stripped;
    }
    return map;
  }

  private stripUndefined(dto: DetectorConfigDto): DetectorConfig {
    const out: DetectorConfig = {};
    if (dto.warningZScore != null) out.warningZScore = dto.warningZScore;
    if (dto.criticalZScore != null) out.criticalZScore = dto.criticalZScore;
    if (dto.warningAbsolute != null) out.warningAbsolute = dto.warningAbsolute;
    if (dto.criticalAbsolute != null) out.criticalAbsolute = dto.criticalAbsolute;
    if (dto.consecutiveRequired != null) out.consecutiveRequired = dto.consecutiveRequired;
    if (dto.cooldownMs != null) out.cooldownMs = dto.cooldownMs;
    return out;
  }
}
