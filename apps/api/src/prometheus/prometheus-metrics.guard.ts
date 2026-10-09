import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveMetricsAccess } from './metrics-access';
import { isCloudMode } from '../common/utils/cloud-mode';

interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class PrometheusMetricsGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const header = request?.headers?.authorization;
    // Only honor the published public token on an actual demo instance
    // (DEMO_HOSTNAME set). If a demo tenant is ever un-flagged and its env
    // lingers, a non-demo instance must not accept the publicly-documented
    // token against real data.
    const isDemoInstance = !!this.configService.get<string>('DEMO_HOSTNAME');
    const access = resolveMetricsAccess({
      enabled: this.configService.get('PROMETHEUS_METRICS_ENABLED'),
      token: this.configService.get<string>('PROMETHEUS_METRICS_TOKEN'),
      publicToken: isDemoInstance
        ? this.configService.get<string>('PROMETHEUS_METRICS_PUBLIC_TOKEN')
        : undefined,
      cloudMode: isCloudMode(),
      authorization: Array.isArray(header) ? header[0] : header,
    });

    if (access === 'disabled') {
      throw new HttpException('Prometheus metrics endpoint disabled', HttpStatus.NOT_FOUND);
    }
    if (access === 'unauthorized') {
      throw new HttpException('Invalid metrics token', HttpStatus.UNAUTHORIZED);
    }
    return true;
  }
}
