import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { PostgresAdapter } from '../adapters/postgres.adapter';
import { MemoryAdapter } from '../adapters/memory.adapter';

@Injectable()
export class StorageClientFactory {
  constructor(private configService: ConfigService) {}

  async createStorageClient(): Promise<StoragePort> {
    const storageType = this.configService.get<string>('STORAGE_TYPE', 'memory');

    let client: StoragePort;

    switch (storageType.toLowerCase()) {
      case 'sqlite': {
        // SQLite adapter only available for local development
        // This import will fail in Docker builds (excluded via .dockerignore)
        try {
          // @ts-ignore - SQLite adapter is excluded from Docker builds via .dockerignore
          const { SqliteAdapter } = await import('../adapters/sqlite.adapter');
          const filepath = this.configService.get<string>(
            'STORAGE_SQLITE_FILEPATH',
            './data/audit.db',
          );
          client = new SqliteAdapter({ filepath });
        } catch (error) {
          throw new Error(
            'SQLite storage is not available in this build. Use STORAGE_TYPE=postgres or STORAGE_TYPE=memory instead.',
          );
        }
        break;
      }
      case 'postgres':
      case 'postgresql': {
        const connectionString = this.configService.get<string>('STORAGE_URL');
        if (!connectionString) {
          throw new Error('STORAGE_URL is required for PostgreSQL storage');
        }
        const schema = this.configService.get<string>('DB_SCHEMA');
        client = new PostgresAdapter({ connectionString, schema });
        break;
      }
      case 'memory':
      default: {
        client = new MemoryAdapter();
        break;
      }
    }

    await client.initialize();
    return client;
  }
}
