import { Module } from '@nestjs/common';

/**
 * DatabaseModule is now minimal.
 * Connection management has been moved to ConnectionsModule which provides ConnectionRegistry globally.
 * Services should inject ConnectionRegistry instead of DATABASE_CLIENT.
 */
@Module({
  imports: [],
  providers: [],
  exports: [],
})
export class DatabaseModule {}
