import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LicenseService } from './license.service';
import { Feature } from './types';

const ENTERPRISE_ONLY_FEATURES = [Feature.AI_ASSISTANT, Feature.SSO_SAML, Feature.RBAC];

@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly license: LicenseService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredFeature = this.reflector.get<Feature | string>('requiredFeature', context.getHandler());
    if (!requiredFeature) return true;

    if (!this.license.hasFeature(requiredFeature)) {
      const requiredTier = ENTERPRISE_ONLY_FEATURES.includes(requiredFeature as Feature)
        ? 'Enterprise'
        : 'Pro or Enterprise';

      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          message: `This feature requires a ${requiredTier} license`,
          feature: requiredFeature,
          currentTier: this.license.getLicenseTier(),
          requiredTier,
          upgradeUrl: 'https://betterdb.dev/pricing',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
