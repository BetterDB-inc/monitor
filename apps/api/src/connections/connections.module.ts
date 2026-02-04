import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../storage/storage.module';
import { ConnectionRegistry } from './connection-registry.service';
import { ConnectionsController } from './connections.controller';

@Global()
@Module({
  imports: [ConfigModule, StorageModule],
  controllers: [ConnectionsController],
  providers: [ConnectionRegistry],
  exports: [ConnectionRegistry],
})
export class ConnectionsModule {}
