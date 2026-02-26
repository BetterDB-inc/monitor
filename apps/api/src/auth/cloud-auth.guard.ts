import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

/**
 * No-op cloud auth guard for self-hosted deployments.
 * In cloud mode, the proprietary implementation replaces this.
 */
@Injectable()
export class CloudAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return true; // Self-hosted: no auth required
  }
}
