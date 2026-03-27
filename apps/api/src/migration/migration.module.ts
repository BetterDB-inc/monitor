import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { MigrationExecutionService } from './migration-execution.service';

@Module({
  imports: [ConnectionsModule],
  controllers: [MigrationController],
  providers: [MigrationService, MigrationExecutionService],
  exports: [MigrationService, MigrationExecutionService],
})
export class MigrationModule {}
