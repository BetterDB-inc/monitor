import { Module } from '@nestjs/common';
import { PosthogProxyController } from './posthog-proxy.controller';

@Module({
  controllers: [PosthogProxyController],
})
export class PosthogProxyModule {}
