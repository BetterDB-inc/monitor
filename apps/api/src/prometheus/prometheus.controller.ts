import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { PrometheusService } from './prometheus.service';

@ApiTags('prometheus')
@Controller('prometheus')
export class PrometheusController {
  constructor(private prometheusService: PrometheusService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({
    summary: 'Get Prometheus metrics',
    description: 'Returns metrics in Prometheus text exposition format for scraping by Prometheus server'
  })
  @ApiProduces('text/plain; version=0.0.4; charset=utf-8')
  @ApiResponse({
    status: 200,
    description: 'Prometheus metrics in text format',
    schema: {
      type: 'string',
      example: '# HELP valkey_info_uptime_seconds Uptime in seconds\n# TYPE valkey_info_uptime_seconds gauge\nvalkey_info_uptime_seconds 3600\n'
    }
  })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getMetrics(): Promise<string> {
    return this.prometheusService.getMetrics();
  }
}
