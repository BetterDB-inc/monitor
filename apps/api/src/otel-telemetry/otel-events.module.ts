import { Global, Module } from '@nestjs/common';
import { OtelEventDispatcherService } from './otel-event-dispatcher.service';

@Global()
@Module({
  providers: [OtelEventDispatcherService],
  exports: [OtelEventDispatcherService],
})
export class OtelEventsModule {}
