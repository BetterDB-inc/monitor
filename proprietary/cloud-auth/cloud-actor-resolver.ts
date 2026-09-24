import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Actor } from '@betterdb/shared';
import type { ActorResolver } from '@app/auth/actor-resolver';
import { cloudActor } from './cloud-actor';
import { readCloudSession } from './cloud-session';

type UpgradeActorResolver = Pick<
  ActorResolver,
  'isEnabled' | 'isReady' | 'enforcesMemberReadOnly' | 'resolveFromUpgrade'
>;

@Injectable()
export class CloudActorResolver implements UpgradeActorResolver {
  isEnabled(): boolean {
    return true;
  }

  isReady(): boolean {
    return true;
  }

  enforcesMemberReadOnly(): boolean {
    return false;
  }

  async resolveFromUpgrade(request: IncomingMessage): Promise<Actor | null> {
    const payload = readCloudSession(request.headers.cookie, request.headers.host);
    if (payload === null) {
      return null;
    }
    return cloudActor(payload);
  }
}
