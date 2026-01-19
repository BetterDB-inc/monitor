import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort } from '../../common/interfaces/database-port.interface';
import { UnifiedDatabaseAdapter } from '../adapters/unified.adapter';
import { DatabaseConfig } from '../../config/configuration';

@Injectable()
export class DatabaseClientFactory {
  constructor(private configService: ConfigService) {}

  async create(): Promise<DatabasePort> {
    const dbConfig = this.configService.get<DatabaseConfig>('database');
    if (!dbConfig) {
      throw new Error('Database configuration not found');
    }

    const { host, port, username, password } = dbConfig;

    // The UnifiedDatabaseAdapter works for both Valkey and Redis
    // It auto-detects the database type during connection
    return new UnifiedDatabaseAdapter({ host, port, username, password });
  }
}
