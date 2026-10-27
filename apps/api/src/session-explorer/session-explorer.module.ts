import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { SessionExplorerService } from './session-explorer.service';
import { SessionExplorerController } from './session-explorer.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [SessionExplorerService],
  controllers: [SessionExplorerController],
})
export class SessionExplorerModule {}
