import { Injectable } from '@nestjs/common';
import { LicenseService } from './license.service';
import { TIER_RETENTION_LIMITS } from './types';

@Injectable()
export class RetentionService {
  constructor(private readonly license: LicenseService) {}

  /**
   * Get the data retention cutoff timestamp for the current tier
   * @returns ISO timestamp string representing the earliest allowed data point
   */
  getDataRetentionCutoff(): Date {
    const tier = this.license.getLicenseTier();
    const retentionDays = TIER_RETENTION_LIMITS[tier].dataRetentionDays;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    return cutoff;
  }

  /**
   * Get the ACL retention cutoff timestamp for the current tier
   * @returns ISO timestamp string representing the earliest allowed ACL data point
   */
  getAclRetentionCutoff(): Date {
    const tier = this.license.getLicenseTier();
    const retentionHours = TIER_RETENTION_LIMITS[tier].aclRetentionHours;
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - retentionHours);
    return cutoff;
  }

  /**
   * Check if a given timestamp is within the data retention window
   */
  isWithinDataRetention(timestamp: Date): boolean {
    return timestamp >= this.getDataRetentionCutoff();
  }

  /**
   * Check if a given timestamp is within the ACL retention window
   */
  isWithinAclRetention(timestamp: Date): boolean {
    return timestamp >= this.getAclRetentionCutoff();
  }

  /**
   * Get retention limits for the current tier
   */
  getRetentionLimits() {
    const tier = this.license.getLicenseTier();
    return TIER_RETENTION_LIMITS[tier];
  }
}
