import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

const BROKER_TRACKER = 'broker';

@Injectable()
export class BrokerThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(): Promise<boolean> {
    return false;
  }

  protected async getTracker(): Promise<string> {
    return BROKER_TRACKER;
  }
}
