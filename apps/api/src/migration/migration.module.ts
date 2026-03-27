import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { MigrationExecutionService } from './migration-execution.service';
import { MigrationValidationService } from './migration-validation.service';

@Module({
  imports: [ConnectionsModule, StorageModule],
  controllers: [MigrationController],
  providers: [MigrationService, MigrationExecutionService, MigrationValidationService],
  exports: [MigrationService, MigrationExecutionService, MigrationValidationService],
})
export class MigrationModule {}
