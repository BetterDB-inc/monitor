import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LicenseService } from './license.service';
import { Feature, Tier } from './types';

const ENTERPRISE_ONLY_FEATURES = [Feature.SSO_SAML, Feature.COMPLIANCE_EXPORT, Feature.RBAC, Feature.AI_CLOUD];

@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly license: LicenseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.get<Feature | string>('requiredFeature', context.getHandler());
    if (!requiredFeature) return true;

    // For paid tier features, ensure license validation has completed
    // This prevents false denials during startup when validation is still in progress
    const isPaidFeature = !this.isCommunityFeature(requiredFeature);
    if (isPaidFeature && !this.license.isValidationComplete()) {
      await this.license.ensureValidated();
    }

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

  private isCommunityFeature(feature: Feature | string): boolean {
    // Community features are those NOT in the Feature enum (which only contains paid features)
    // If the feature string is not in Feature enum values, it's a community feature
    const paidFeatures = Object.values(Feature);
    return !paidFeatures.includes(feature as Feature);
  }
}
