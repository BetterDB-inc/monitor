import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class MonitorDevPreviewGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (process.env.MONITOR_DEV_PREVIEW !== 'true') {
      throw new NotFoundException();
    }
    return true;
  }
}
